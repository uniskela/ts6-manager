package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func setHostOS(t *testing.T, goos string) {
	t.Helper()
	old := hostOS
	hostOS = goos
	t.Cleanup(func() { hostOS = old })
}

func TestBackendUnsupportedReason(t *testing.T) {
	cases := []struct {
		goos, backend, want string
	}{
		{"linux", backendVAAPI, ""},
		{"windows", backendVAAPI, "VAAPI is only available on Linux"},
		{"darwin", backendVAAPI, "VAAPI is only available on Linux"},
		{"darwin", backendVideoToolbox, ""},
		{"linux", backendVideoToolbox, "VideoToolbox is only available on macOS"},
		{"windows", backendVideoToolbox, "VideoToolbox is only available on macOS"},
		// NVENC and AMF are decided by their test encodes on every system.
		{"linux", backendNVENC, ""},
		{"windows", backendNVENC, ""},
		{"darwin", backendNVENC, ""},
		{"linux", backendAMF, ""},
		{"windows", backendAMF, ""},
		// Software encoders have no backend.
		{"darwin", "", ""},
	}
	for _, c := range cases {
		setHostOS(t, c.goos)
		if got := backendUnsupportedReason(c.backend); got != c.want {
			t.Errorf("%s on %s: got %q, want %q", c.backend, c.goos, got, c.want)
		}
	}
}

func TestVideoToolboxSpecAndArgs(t *testing.T) {
	t.Setenv("VIDEO_GOP", "15")
	spec, ok := lookupEncoder("h264_videotoolbox")
	if !ok || !spec.Hardware || spec.Backend != backendVideoToolbox || spec.Codec != codecH264 || spec.FFmpeg != "h264_videotoolbox" {
		t.Fatalf("h264_videotoolbox spec = %+v (found %v)", spec, ok)
	}
	if got := uploadFilter(spec); got != "format=nv12" {
		t.Fatalf("VideoToolbox filter = %q", got)
	}
	if got := hwInitArgs(spec, true); got != nil {
		t.Fatalf("VideoToolbox needs no device or hwaccel args, got %v", got)
	}
	args := strings.Join(encoderArgs(spec, "2500k", false, 0), " ")
	for _, want := range []string{
		"-c:v h264_videotoolbox", "-profile:v high", "-bf 0", "-realtime 1", "-allow_sw 0",
		"-b:v 2500k", "-maxrate 2500k", "-g 15",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("h264_videotoolbox args missing %q: %s", want, args)
		}
	}
	for _, forbidden := range []string{"hwupload", "-low_power", "-minrate", "-init_hw_device"} {
		if strings.Contains(args, forbidden) {
			t.Errorf("h264_videotoolbox args must not contain %q: %s", forbidden, args)
		}
	}
	// A VideoToolbox failure keeps viewers on the codec they negotiated.
	if sw := softwareEncoderFor(spec.Codec); sw.ID != "h264" || sw.Hardware {
		t.Fatalf("VideoToolbox software fallback = %+v", sw)
	}
}

func TestProbeSkipsVideoToolboxOffMacOS(t *testing.T) {
	spec, _ := lookupEncoder("h264_videotoolbox")
	for _, goos := range []string{"linux", "windows"} {
		setHostOS(t, goos)
		calls := 0
		res := probeOneEncoder(spec, true, func(ctx context.Context, args []string) (string, error) {
			calls++
			return "", nil
		})
		if calls != 0 || res.Available || len(res.Attempts) != 0 {
			t.Fatalf("%s: VideoToolbox must not be probed, got %+v after %d calls", goos, res, calls)
		}
		if res.Skipped != "VideoToolbox is only available on macOS" || res.Error != res.Skipped {
			t.Fatalf("%s: unexpected skip reason %+v", goos, res)
		}
	}
}

func TestProbeRunsVideoToolboxOnMacOS(t *testing.T) {
	setHostOS(t, "darwin")
	spec, _ := lookupEncoder("h264_videotoolbox")

	calls := 0
	res := probeOneEncoder(spec, false, func(ctx context.Context, args []string) (string, error) {
		calls++
		joined := strings.Join(args, " ")
		for _, want := range []string{"-f lavfi", "-vf format=nv12", "-c:v h264_videotoolbox", "-allow_sw 0"} {
			if !strings.Contains(joined, want) {
				t.Errorf("VideoToolbox probe missing %q: %s", want, joined)
			}
		}
		return "", nil
	})
	if calls != 1 || !res.Available || res.Skipped != "" || len(res.Attempts) != 1 {
		t.Fatalf("expected one passing VideoToolbox probe, got %+v after %d calls", res, calls)
	}

	// An Intel Mac without a hardware H.264 encoder fails the test encode.
	res = probeOneEncoder(spec, false, func(ctx context.Context, args []string) (string, error) {
		return "[h264_videotoolbox] Error: cannot create compression session: -12908\n", errors.New("exit status 1")
	})
	if res.Available || res.Error == "" || res.Skipped != "" || len(res.Attempts) != 1 {
		t.Fatalf("expected a failed VideoToolbox probe with its reason, got %+v", res)
	}
}

func TestProbeSkipsVaapiOffLinuxEvenWithADevicePath(t *testing.T) {
	setHostOS(t, "windows")
	spec, _ := lookupEncoder("h264_vaapi")
	calls := 0
	res := probeOneEncoder(spec, true, func(ctx context.Context, args []string) (string, error) {
		calls++
		return "", nil
	})
	if calls != 0 || res.Available || res.Skipped != "VAAPI is only available on Linux" {
		t.Fatalf("VAAPI must be skipped off Linux, got %+v after %d calls", res, calls)
	}
}
