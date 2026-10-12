package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Output of `ffmpeg -hide_banner -encoders` from a static Linux FFmpeg 7.0.2
// (no AMF, NVENC or VAAPI), shortened.
const realEncoderListOutput = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libvpx               libvpx VP8 (codec vp8)
 A....D aac                  AAC (Advanced Audio Coding)
 S..... ass                  ASS (Advanced SSA) subtitle (codec ass)
`

func TestParseEncoderList(t *testing.T) {
	list := parseEncoderList(realEncoderListOutput)
	for _, name := range []string{"a64multi", "libx264", "libvpx", "aac", "ass"} {
		if list.lacks(name) {
			t.Errorf("%s is listed but parsed as missing", name)
		}
	}
	if !list.lacks("h264_amf") {
		t.Error("h264_amf is not listed")
	}
	// The legend rows above the rule are not encoders.
	if !list.lacks("=") || !list.lacks("Video") {
		t.Error("legend rows were read as encoders")
	}
	// Anything that is not the table leaves the list unknown, which lacks nothing.
	for _, out := range []string{"", "Segmentation fault\n", "Encoders:\n ------\n", "ffmpeg: command not found"} {
		if got := parseEncoderList(out); got != nil || got.lacks("h264_amf") {
			t.Errorf("parseEncoderList(%q) = %v, want unknown", out, got)
		}
	}
}

// The probe of an encoder the build lacks says so and does not run ffmpeg;
// the same encoder in the list is test-encoded as before, header spacing
// included.
func TestProbeUsesTheEncoderList(t *testing.T) {
	setHostOS(t, "windows")
	t.Setenv("VIDEO_GOP", "15")
	spec := mustEncoder(t, "h264_amf")
	run := func(ctx context.Context, args []string) (string, error) {
		t.Fatalf("ffmpeg must not run for an encoder the build lacks: %v", args)
		return "", nil
	}

	res := probeOneEncoderIn(spec, false, parseEncoderList(realEncoderListOutput), run)
	want := "This FFmpeg build has no h264_amf encoder (AMF needs an FFmpeg built with AMF support and an AMD driver)"
	if res.Available || res.Error != want || len(res.Attempts) != 0 ||
		!strings.Contains(res.Skipped, "ffmpeg -hide_banner -encoders") || !strings.Contains(res.Skipped, "h264_amf") {
		t.Errorf("absent encoder: got %+v", res)
	}

	var seen string
	present := parseEncoderList(encoderTable([]string{"libx264", "h264_amf"}))
	res = probeOneEncoderIn(spec, false, present, func(ctx context.Context, args []string) (string, error) {
		seen = strings.Join(args, " ")
		return "", nil
	})
	if !res.Available || res.Error != "" || !strings.Contains(seen, "-c:v h264_amf") || !strings.Contains(seen, "-header_spacing 15") {
		t.Errorf("present encoder: got %+v after %q", res, seen)
	}
}

// Only hardware encoders are checked, and the other backends read the same.
func TestMissingEncoderReason(t *testing.T) {
	list := parseEncoderList(realEncoderListOutput)
	for id, hint := range map[string]string{
		"h264_nvenc":        "NVENC needs an FFmpeg built with NVENC support and an NVIDIA driver",
		"h264_vaapi":        "VAAPI needs an FFmpeg built with VAAPI support",
		"h264_videotoolbox": "VideoToolbox needs",
	} {
		if got := missingEncoderReason(mustEncoder(t, id), list); !strings.HasPrefix(got, "This FFmpeg build has no "+id+" encoder (") || !strings.Contains(got, hint) {
			t.Errorf("%s: %q", id, got)
		}
	}
	for _, id := range []string{"vp8", "vp9", "h264"} {
		if got := missingEncoderReason(mustEncoder(t, id), parseEncoderList(encoderTable(nil))); got != "" {
			t.Errorf("software encoder %s checked: %q", id, got)
		}
	}
	if got := missingEncoderReason(mustEncoder(t, "h264_amf"), nil); got != "" {
		t.Errorf("unknown list must not claim a missing encoder: %q", got)
	}
}

// fullFFmpegBuild is a probe runner standing in for an ffmpeg built with every
// encoder the registry knows, so a test of the first attempt does not depend on
// the ffmpeg installed on the machine running it.
func fullFFmpegBuild(ctx context.Context, args []string) (string, error) {
	var names []string
	for _, spec := range encoderOrder {
		names = append(names, spec.FFmpeg)
	}
	return encoderTable(names), nil
}

func queryCount(t *testing.T, calls string) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(filepath.Dir(calls), "queries"))
	if err != nil {
		return 0
	}
	return strings.Count(string(b), "\n")
}

func ffmpegRuns(t *testing.T, calls string) []string {
	t.Helper()
	b, _ := os.ReadFile(calls)
	var runs []string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l != "" {
			runs = append(runs, l)
		}
	}
	return runs
}

func fakeFFmpegLackingAMF(t *testing.T) string {
	t.Helper()
	// Test encodes (they end in "-f null -") finish at once; a stream keeps running.
	calls := installFakeFFmpeg(t, "case \"$*\" in *\"-f null -\") exit 0 ;; esac\nexec sleep 30\n")
	writeEncoderTable(t, filepath.Dir(calls), []string{"libx264", "libvpx", "libvpx-vp9", "h264_nvenc"})
	return calls
}

// A stream that asks for an encoder the FFmpeg build lacks starts on the
// software encoder of its codec with a plain reason, without ffmpeg being
// launched for the hardware encoder, and the list is asked for once.
func TestStreamStartsInSoftwareWhenBuildLacksEncoder(t *testing.T) {
	setHostOS(t, "windows")
	calls := fakeFFmpegLackingAMF(t)
	s := NewSidecar()
	defer s.Stop()

	session, err := s.StartFFmpeg(SourceRequest{Encoder: "h264_amf", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Requested != "h264_amf" || session.Active != "h264" || session.Hardware ||
		!strings.HasPrefix(session.FallbackReason, "This FFmpeg build has no h264_amf encoder (AMF needs") {
		t.Fatalf("got %+v", session)
	}
	waitForCalls(t, calls, 1)
	runs := ffmpegRuns(t, calls)
	if len(runs) != 1 || strings.Contains(runs[0], "h264_amf") || strings.Contains(runs[0], "header_spacing") || !strings.Contains(runs[0], "-c:v libx264") {
		t.Errorf("only the software encoder may launch, once: %q", runs)
	}
	if n := queryCount(t, calls); n != 1 {
		t.Errorf("the encoder list was asked for %d times, want once", n)
	}
}

// Check encoders reports the missing encoder, shares the list with stream
// starts, and asks again only on a refresh.
func TestCapabilityCacheAsksForTheEncoderListOnce(t *testing.T) {
	setHostOS(t, "windows")
	calls := fakeFFmpegLackingAMF(t)
	s := NewSidecar()
	defer s.Stop()

	caps := s.caps.get(false)
	amf, _ := caps.find("h264_amf")
	if amf.Available || !strings.HasPrefix(amf.Error, "This FFmpeg build has no h264_amf encoder") || len(amf.Attempts) != 0 || amf.Skipped == "" {
		t.Errorf("h264_amf row: %+v", amf)
	}
	if nvenc, _ := caps.find("h264_nvenc"); len(nvenc.Attempts) != 1 {
		t.Errorf("an encoder the build has is still test-encoded: %+v", nvenc)
	}
	if sw, _ := caps.find("h264"); !sw.Available {
		t.Errorf("software h264 must stay available: %+v", sw)
	}
	s.caps.get(false)
	if _, err := s.StartFFmpeg(SourceRequest{Encoder: "h264_amf", Volume: 100}); err != nil {
		t.Fatal(err)
	}
	if n := queryCount(t, calls); n != 1 {
		t.Errorf("list queried %d times for a probe, a cached probe and a stream start; want 1", n)
	}
	s.caps.get(true)
	if n := queryCount(t, calls); n != 2 {
		t.Errorf("a refresh must ask again; queries = %d", n)
	}
}

// An FFmpeg that cannot list its encoders (or prints nothing usable) is treated
// as before: the encoder is launched, and the probe test-encodes it.
func TestEncoderListFailureKeepsEarlierBehaviour(t *testing.T) {
	setHostOS(t, "windows")
	for name, prepare := range map[string]func(t *testing.T, dir string){
		"query fails": func(t *testing.T, dir string) {
			if err := os.Remove(filepath.Join(dir, "encoders.txt")); err != nil {
				t.Fatal(err)
			}
		},
		"unrecognizable output": func(t *testing.T, dir string) {
			if err := os.WriteFile(filepath.Join(dir, "encoders.txt"), []byte("not a table\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			calls := installFakeFFmpeg(t, "exec sleep 30\n")
			prepare(t, filepath.Dir(calls))
			s := NewSidecar()
			defer s.Stop()

			session, err := s.StartFFmpeg(SourceRequest{Encoder: "h264_amf", Volume: 100})
			if err != nil {
				t.Fatal(err)
			}
			if session.Active != "h264_amf" || session.FallbackReason != "" {
				t.Errorf("want the hardware encoder launched as before, got %+v", session)
			}
			runs := waitForCalls(t, calls, 1)
			if !strings.Contains(runs[0], "-c:v h264_amf") || !strings.Contains(runs[0], "-header_spacing") {
				t.Errorf("first run: %s", runs[0])
			}

			res := probeOneEncoderIn(mustEncoder(t, "h264_amf"), false, queryEncoderList(s.caps.runner()),
				func(ctx context.Context, args []string) (string, error) {
					return "Unknown encoder 'h264_amf'\n", errors.New("exit status 8")
				})
			if res.Error != "Unknown encoder 'h264_amf'" || len(res.Attempts) != 1 {
				t.Errorf("probe without a list: %+v", res)
			}
		})
	}
}
