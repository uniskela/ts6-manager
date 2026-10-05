package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestPortableMusicSources(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MUSIC_DIR", root)
	for _, name := range []string{"clip.mp4", ".stream-123.mp4"} {
		local := filepath.Join(root, name)
		if err := os.WriteFile(local, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := resolveMusicSource("music://" + name)
		if err != nil || got != local {
			t.Fatalf("resolve %s = %q, %v; want %q", name, got, err, local)
		}
		if err := validSource("music://" + name); err != nil {
			t.Fatal(err)
		}
	}
	for _, source := range []string{"", "https://example.com/clip.mp4", "http://example.com/live", filepath.Join(root, "clip.mp4")} {
		if got, err := resolveMusicSource(source); err != nil || got != source {
			t.Errorf("existing source %q changed to %q, %v", source, got, err)
		}
		if err := validSource(source); err != nil {
			t.Errorf("existing source %q rejected: %v", source, err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "directory"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{
		"music://", "music://..", "music://../clip.mp4", "music://sub/clip.mp4",
		`music://..\clip.mp4`, "music:///clip.mp4", "music://C:\\clip.mp4",
		"music://%2e%2e%2fclip.mp4", "music://clip.mp4?query", "music://clip.mp4#fragment",
		"music://clip.mp4\x00", "music://missing.mp4", "music://directory",
	} {
		if err := validSource(source); err == nil {
			t.Errorf("accepted invalid source %q", source)
		}
		s := NewSidecar()
		if _, err := s.StartFFmpeg(SourceRequest{Source: source, Encoder: "h264"}); err == nil {
			t.Errorf("StartFFmpeg accepted invalid source %q", source)
		}
	}
	if err := validSource(filepath.Join(t.TempDir(), "outside.mp4")); err == nil {
		t.Fatal("absolute paths outside MUSIC_DIR must still be rejected")
	}
}

func TestPortableMusicRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MUSIC_DIR", root)
	outside := filepath.Join(t.TempDir(), "outside.mp4")
	if err := os.WriteFile(outside, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.mp4")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := validSource("music://escape.mp4"); err == nil {
		t.Fatal("symlink escaped MUSIC_DIR")
	}
	// MUSIC_DIR itself may be a symlink/junction to a trusted shared directory.
	local := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(local, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	linkedRoot := filepath.Join(t.TempDir(), "music")
	if err := os.Symlink(root, linkedRoot); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MUSIC_DIR", linkedRoot)
	if got, err := resolveSource("music://clip.mp4"); err != nil || got != local {
		t.Fatalf("symlinked music root = %q, %v; want %q", got, err, local)
	}
}

// Exercise the actual StartFFmpeg boundary and codec-preserving AMF fallback.
func TestFFmpegPortableMusicSource(t *testing.T) {
	if os.Getenv("SIDECAR_FFMPEG_IT") != "1" {
		t.Skip("set SIDECAR_FFMPEG_IT=1 to run against a real ffmpeg")
	}
	root := t.TempDir()
	t.Setenv("MUSIC_DIR", root)
	local := filepath.Join(root, ".stream-123.mp4")
	cmd := exec.Command(getFfmpegPath(), "-v", "error", "-f", "lavfi", "-i", "color=s=320x240:r=30",
		"-f", "lavfi", "-i", "sine", "-t", "1", "-c:v", "libx264", "-c:a", "aac", local)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v: %s", err, out)
	}
	s := NewSidecar()
	if err := s.StartRTP(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	spec, _ := lookupEncoder("h264_amf")
	s.caps.caps = &EncoderCapabilities{Encoders: []EncoderProbeResult{{EncoderSpec: spec, Error: "AMF unavailable"}}}
	session, err := s.StartFFmpeg(SourceRequest{Source: "music://.stream-123.mp4", Encoder: "h264_amf", Loop: true, Volume: 100})
	if err != nil {
		t.Fatal(err)
	}
	if session.Requested != "h264_amf" || session.Active != "h264" || session.Codec != codecH264 || session.Hardware || session.FallbackReason != "AMF unavailable" {
		t.Fatalf("AMF fallback = %+v", session)
	}
	if s.source != local {
		t.Fatalf("ffmpeg source = %q, want native path %q", s.source, local)
	}
	deadline := time.Now().Add(5 * time.Second)
	for atomic.LoadUint64(&s.videoPktCount) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if atomic.LoadUint64(&s.videoPktCount) == 0 {
		t.Fatalf("no video RTP from shared file: %+v", s.encoderSession())
	}
}
