package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The audio output only ever takes audio, and the silent input, when there
// is one, comes after the source's inputs.
func TestAudioOutputTakesAudioOnly(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")

	got := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/v.mp4", Volume: 100}, spec, false), " ")
	if !strings.Contains(got, "-map 0:a:0? -vn -sn -dn") {
		t.Errorf("the audio output must refuse video: %s", got)
	}
	if strings.Contains(got, "anullsrc") {
		t.Errorf("no silence unless the source lacks audio: %s", got)
	}

	got = strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/v.mp4", Volume: 100, SilentAudio: true}, spec, false), " ")
	if !strings.Contains(got, "-i https://example.com/v.mp4 -re -f lavfi -i anullsrc=") || !strings.Contains(got, "-map 1:a:0 -vn") {
		t.Errorf("silence must be input 1 and feed the audio output: %s", got)
	}

	got = strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://example.com/v.webm", AudioSource: "https://example.com/a.webm", Volume: 100, SilentAudio: true}, spec, false), " ")
	if !strings.Contains(got, "-map 2:a:0 -vn") {
		t.Errorf("with a separate audio input, silence is input 2: %s", got)
	}
}

func TestNoAudioTrackIsRecognised(t *testing.T) {
	tail := &tailBuffer{}
	_, _ = tail.Write([]byte("Input #0, matroska,webm, from 'x':\nOutput file #1 does not contain any stream\n"))
	if !noAudioTrack(tail) {
		t.Error("a source without audio must be recognised")
	}
	for _, out := range []string{
		"Server returned 403 Forbidden (access denied)\n",
		"Output file #0 does not contain any stream\n",
	} {
		other := &tailBuffer{}
		_, _ = other.Write([]byte(out))
		if noAudioTrack(other) {
			t.Errorf("another failure must not be taken for a missing audio track: %q", out)
		}
	}
}

// fakeFFmpeg installs an ffmpeg that behaves like the real one for a source
// without audio: without the silent input it stops with ffmpeg 5.1's error,
// with it it keeps running. Each call's arguments are appended to the
// returned log file.
func fakeFFmpeg(t *testing.T) string {
	t.Helper()
	return installFakeFFmpeg(t, "case \"$*\" in *anullsrc*) exec sleep 30 ;; esac\n"+
		"echo 'Output file #1 does not contain any stream' >&2\nexit 1\n")
}

// installFakeFFmpeg installs a shell script as ffmpeg. It appends each run's
// arguments to the returned log file and then runs behaviour.
func installFakeFFmpeg(t *testing.T, behaviour string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a POSIX shell")
	}
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	// The script finds the log next to itself, so no path is written into it
	// and the temp directory may hold any character. One line per run: an
	// argument can hold a line break (the HTTP headers option does).
	script := "#!/bin/sh\nlog=\"${0%/*}/calls\"\n" +
		"printf '%s\\n' \"$*\" | tr -d '\\r' | tr '\\n' ' ' >> \"$log\"\necho >> \"$log\"\n" + behaviour
	bin := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", bin)
	t.Setenv("SIDECAR_EGRESS_PROXY", "off")
	return calls
}

func waitForCalls(t *testing.T, calls string, n int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(calls); err == nil {
			if lines := strings.Split(strings.TrimSpace(string(b)), "\n"); len(lines) >= n {
				return lines
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	b, _ := os.ReadFile(calls)
	t.Fatalf("expected %d ffmpeg runs, got:\n%s", n, b)
	return nil
}

// A software encode returns before ffmpeg has opened the source, so the
// restart happens after StartFFmpeg has answered.
func TestSourceWithoutAudioRestartsWithSilence(t *testing.T) {
	calls := fakeFFmpeg(t)
	s := NewSidecar()
	defer s.Stop()
	if _, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/video-only.mp4", Encoder: "h264", Volume: 100}); err != nil {
		t.Fatal(err)
	}
	lines := waitForCalls(t, calls, 2)
	if strings.Contains(lines[0], "anullsrc") || !strings.Contains(lines[1], "anullsrc") {
		t.Errorf("first run without silence, second with it:\n%s", strings.Join(lines, "\n"))
	}
	time.Sleep(200 * time.Millisecond)
	if b, _ := os.ReadFile(calls); strings.Count(string(b), "\n") != 2 {
		t.Errorf("silence must be added once, not in a loop:\n%s", b)
	}
}

// A hardware encoder that stops because the source lacks audio has not
// failed: it must not fall back to software.
func TestSourceWithoutAudioKeepsTheHardwareEncoder(t *testing.T) {
	calls := fakeFFmpeg(t)
	t.Setenv("VAAPI_VERIFY_MS", "300")
	s := NewSidecar()
	defer s.Stop()
	session, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/video-only.mp4", Encoder: "h264_nvenc", Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Active != "h264_nvenc" || session.FallbackReason != "" {
		t.Errorf("encoder fell back: %+v", session)
	}
	lines := waitForCalls(t, calls, 2)
	if !strings.Contains(lines[1], "anullsrc") || !strings.Contains(lines[1], "h264_nvenc") {
		t.Errorf("second run must be the same encoder with silence:\n%s", strings.Join(lines, "\n"))
	}
}
