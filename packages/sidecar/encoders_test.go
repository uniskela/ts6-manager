package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestSoftwareFallbackKeepsCodecFamily(t *testing.T) {
	for _, spec := range encoderOrder {
		sw := softwareEncoderFor(spec.Codec)
		if sw.Hardware {
			t.Fatalf("fallback for %s is hardware", spec.ID)
		}
		if sw.Codec != spec.Codec {
			t.Fatalf("fallback for %s changed codec %s -> %s", spec.ID, spec.Codec, sw.Codec)
		}
	}
}

func TestH264OffersConstrainedHigh(t *testing.T) {
	c := codecCapability(codecH264)
	if c.MimeType != webrtc.MimeTypeH264 {
		t.Fatalf("mime = %s", c.MimeType)
	}
	if !strings.Contains(c.SDPFmtpLine, "profile-level-id=640c") {
		t.Fatalf("H.264 must be offered as Constrained High, got %q", c.SDPFmtpLine)
	}
	if !strings.Contains(c.SDPFmtpLine, "packetization-mode=1") {
		t.Fatalf("ffmpeg sends FU-A, so packetization-mode=1 is required: %q", c.SDPFmtpLine)
	}
}

func TestEncoderArgsHardwareUsesUploadAndLowPower(t *testing.T) {
	spec, _ := lookupEncoder("h264_vaapi")
	args := strings.Join(encoderArgs(spec, "4500k", true, 0), " ")
	for _, want := range []string{"-c:v h264_vaapi", "-profile:v high", "-bf 0", "-low_power 1", "-b:v 4500k"} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_vaapi args missing %q: %s", want, args)
		}
	}
	if uploadFilter(spec) != "format=nv12,hwupload" {
		t.Errorf("hardware filter = %q", uploadFilter(spec))
	}
	sw, _ := lookupEncoder("vp9")
	swArgs := strings.Join(encoderArgs(sw, "2500k", true, 0), " ")
	if strings.Contains(swArgs, "low_power") {
		t.Errorf("software encoder must not get -low_power: %s", swArgs)
	}
	if !strings.Contains(swArgs, "-strict experimental") {
		t.Errorf("VP9 RTP packetization needs -strict experimental: %s", swArgs)
	}
}

func TestEncoderArgsHonorsCpuUsed(t *testing.T) {
	spec, _ := lookupEncoder("vp8")
	args := strings.Join(encoderArgs(spec, "2500k", false, 6), " ")
	if !strings.Contains(args, "-cpu-used 6") {
		t.Fatalf("expected cpu-used 6, got %s", args)
	}
	def := strings.Join(encoderArgs(spec, "2500k", false, 0), " ")
	if !strings.Contains(def, "-cpu-used 4") {
		t.Fatalf("cpuUsed 0 should keep env/default 4, got %s", def)
	}
}

func TestLibvpxHoldsBitrateWithMinrate(t *testing.T) {
	for _, id := range []string{"vp8", "vp9"} {
		spec, _ := lookupEncoder(id)
		args := strings.Join(encoderArgs(spec, "5500k", false, 0), " ")
		if !strings.Contains(args, "-minrate 5500k") {
			t.Errorf("%s needs -minrate to hold its bitrate: %s", id, args)
		}
	}
	for _, id := range []string{"h264", "vp9_vaapi", "h264_vaapi"} {
		spec, _ := lookupEncoder(id)
		if args := strings.Join(encoderArgs(spec, "5500k", false, 0), " "); strings.Contains(args, "-minrate") {
			t.Errorf("%s holds -maxrate on its own and must not get -minrate: %s", id, args)
		}
	}
}

func TestBuildFFmpegArgsSoftwareKeepsVP8Contract(t *testing.T) {
	s := NewSidecar()
	s.videoPort, s.audioPort = 5000, 5002
	spec, _ := lookupEncoder("vp8")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{
		Source: "https://example.com/live.m3u8", Width: 1920, Height: 1080, Framerate: 30, Bitrate: "4500k", Volume: 100,
	}, spec, false), " ")
	for _, want := range []string{
		"-reconnect 1", "-re -i https://example.com/live.m3u8",
		"scale=1920:1080:force_original_aspect_ratio=decrease", "format=yuv420p",
		"-c:v libvpx", "rtp://127.0.0.1:5000", "-c:a libopus", "rtp://127.0.0.1:5002",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
	if strings.Contains(args, "init_hw_device") {
		t.Errorf("software encode must not open a VAAPI device: %s", args)
	}
}

func TestBuildFFmpegArgsVaapiOpensDevice(t *testing.T) {
	t.Setenv("VAAPI_DEVICE", "/dev/dri/renderD129")
	t.Setenv("VIDEO_HW_DECODE", "1")
	s := NewSidecar()
	spec, _ := lookupEncoder("h264_vaapi")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/a.mp4", Width: 3840, Height: 2160}, spec, false), " ")
	for _, want := range []string{"-init_hw_device vaapi=va:/dev/dri/renderD129", "-filter_hw_device va", "-hwaccel vaapi", "format=nv12,hwupload"} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
	if strings.Index(args, "-init_hw_device") > strings.Index(args, "-i https://") {
		t.Errorf("hardware init must precede the input: %s", args)
	}
}

func TestProbeSkipsHardwareWithoutDevice(t *testing.T) {
	calls := 0
	run := func(ctx context.Context, args []string) (string, error) {
		calls++
		return "", nil
	}
	spec, _ := lookupEncoder("vp8_vaapi")
	res := probeOneEncoder(spec, false, run)
	if res.Available || calls != 0 {
		t.Fatalf("expected skip without device, got available=%v calls=%d", res.Available, calls)
	}
	if res.Error == "" {
		t.Fatal("expected a reason for the unavailable hardware encoder")
	}
}

func TestProbeRetriesHardwareWithLowPower(t *testing.T) {
	t.Setenv("VAAPI_LOW_POWER", "")
	run := func(ctx context.Context, args []string) (string, error) {
		if strings.Contains(strings.Join(args, " "), "-low_power 1") {
			return "", nil
		}
		return "[h264_vaapi] No usable encoding entrypoint found for profile VAProfileH264High\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_vaapi")
	res := probeOneEncoder(spec, true, run)
	if !res.Available || !res.LowPower {
		t.Fatalf("expected low-power success, got %+v", res)
	}
}

func TestProbeReportsFailureReason(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) {
		return "Unknown encoder 'libx264'\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264")
	res := probeOneEncoder(spec, true, run)
	if res.Available || res.Error != "Unknown encoder 'libx264'" {
		t.Fatalf("unexpected result %+v", res)
	}
}

// A host without the NVIDIA runtime fails the NVENC probe while loading the
// driver; the row says so plainly and keeps ffmpeg's text as the detail.
func TestProbeNvencWithoutDriver(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) {
		return "[h264_nvenc @ 0x564b2539c3c0] Cannot load libcuda.so.1\n" +
				"[vost#0:0/h264_nvenc @ 0x1] Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\n",
			errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_nvenc")
	res := probeOneEncoder(spec, false, run)
	if res.Available || res.Error != "NVIDIA GPU/runtime not present" {
		t.Fatalf("unexpected result %+v", res)
	}
	if !strings.Contains(res.Detail, "Cannot load libcuda.so.1") {
		t.Fatalf("raw ffmpeg reason should be kept as detail, got %q", res.Detail)
	}
}

// Other NVENC failures (a GPU that is present but rejects the settings) keep
// ffmpeg's own reason.
func TestProbeNvencOtherFailureKeepsReason(t *testing.T) {
	run := func(ctx context.Context, args []string) (string, error) {
		return "[h264_nvenc @ 0x1] Driver does not support the required nvenc API version\n", errors.New("exit status 1")
	}
	spec, _ := lookupEncoder("h264_nvenc")
	res := probeOneEncoder(spec, false, run)
	if !strings.Contains(res.Error, "nvenc API version") || res.Detail != "" {
		t.Fatalf("unexpected result %+v", res)
	}
}

func TestSummarizeFFmpegErrorRedactsURLs(t *testing.T) {
	out := "noise\r\nhttps://user:pass@iptv.example/live/1.ts: Server returned 403 Forbidden\nError opening input files: Server returned 403 Forbidden\n"
	got := summarizeFFmpegError(out)
	if strings.Contains(got, "pass@") || strings.Contains(got, "iptv.example") {
		t.Fatalf("URL leaked into reason: %q", got)
	}
	if !strings.Contains(got, "<source> Server returned 403") || !strings.Contains(got, "Error opening input files") {
		t.Fatalf("unexpected summary: %q", got)
	}
}

// FFmpeg's default RTP packet is 1472 bytes; with SRTP added it no longer fits
// a 1500-byte MTU and is fragmented on the way to the viewer.
func TestVideoRTPPacketsFitTheMTU(t *testing.T) {
	s := NewSidecar()
	for _, key := range []string{"vp8", "vp9", "h264_vaapi"} {
		spec, ok := lookupEncoder(key)
		if !ok {
			t.Fatalf("no %s encoder", key)
		}
		args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4"}, spec, false), " ")
		const want = "-f rtp -pkt_size 1200 rtp://127.0.0.1:"
		if !strings.Contains(args, want) {
			t.Errorf("%s: video output must cap the packet size (%q): %s", key, want, args)
		}
	}
}

// NVENC takes NV12 frames from system memory: no VAAPI device, no hwupload,
// and no -low_power, which only VAAPI knows.
func TestBuildFFmpegArgsNvenc(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "")
	s := NewSidecar()
	spec, ok := lookupEncoder("h264_nvenc")
	if !ok || !spec.Hardware || spec.Backend != backendNVENC || spec.Codec != codecH264 {
		t.Fatalf("h264_nvenc spec = %+v (found %v)", spec, ok)
	}
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4", Width: 1920, Height: 1080, Bitrate: "4500k"}, spec, true), " ")
	for _, want := range []string{
		"-c:v h264_nvenc", "-profile:v high", "-preset p4", "-tune ll", "-rc cbr", "-zerolatency 1", "-bf 0",
		"-b:v 4500k", "-maxrate 4500k", ",format=nv12 ",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_nvenc args missing %q: %s", want, args)
		}
	}
	for _, not := range []string{"hwupload", "-init_hw_device", "vaapi", "-low_power", "-hwaccel"} {
		if strings.Contains(args, not) {
			t.Errorf("h264_nvenc args must not contain %q: %s", not, args)
		}
	}
}

func TestNvencDecodesOnCudaWhenHwDecodeIsOn(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	s := NewSidecar()
	spec, _ := lookupEncoder("h264_nvenc")
	args := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "/data/music/clip.mp4"}, spec, false), " ")
	if !strings.Contains(args, "-hwaccel cuda") {
		t.Fatalf("VIDEO_HW_DECODE=1 must decode on the GPU: %s", args)
	}
	if strings.Index(args, "-hwaccel cuda") > strings.Index(args, "-i /data/music/clip.mp4") {
		t.Errorf("-hwaccel must precede the input: %s", args)
	}
	// Frames must come back to system memory for the filter chain and NVENC.
	if strings.Contains(args, "hwaccel_output_format") {
		t.Errorf("decoded frames must stay in system memory: %s", args)
	}
}

// The VAAPI render node says nothing about NVENC: it is probed whether or not
// one is present, and once, since it has no low-power mode to retry with.
func TestProbeRunsNvencWithoutVaapiDevice(t *testing.T) {
	calls := 0
	run := func(ctx context.Context, args []string) (string, error) {
		calls++
		if strings.Contains(strings.Join(args, " "), "low_power") {
			t.Errorf("NVENC probe must not use -low_power: %v", args)
		}
		return "", nil
	}
	spec, _ := lookupEncoder("h264_nvenc")
	res := probeOneEncoder(spec, false, run)
	if !res.Available || calls != 1 {
		t.Fatalf("expected one successful probe, got available=%v calls=%d err=%q", res.Available, calls, res.Error)
	}

	calls = 0
	fail := func(ctx context.Context, args []string) (string, error) {
		calls++
		return "[h264_nvenc] Cannot load libnvidia-encode.so.1\n", errors.New("exit status 1")
	}
	res = probeOneEncoder(spec, true, fail)
	if res.Available || calls != 1 || res.Error != "NVIDIA GPU/runtime not present" || !strings.Contains(res.Detail, "libnvidia-encode") {
		t.Fatalf("expected one failed probe with its reason, got %+v after %d calls", res, calls)
	}
}

func TestHardwareEncodersNameTheirBackend(t *testing.T) {
	for _, spec := range encoderOrder {
		switch {
		case !spec.Hardware && spec.Backend != "":
			t.Errorf("software encoder %s has backend %q", spec.ID, spec.Backend)
		case spec.Hardware && spec.Backend != backendVAAPI && spec.Backend != backendNVENC:
			t.Errorf("hardware encoder %s has backend %q", spec.ID, spec.Backend)
		}
	}
}
