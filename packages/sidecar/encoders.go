package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// Video codec families the sidecar can packetize and negotiate with viewers.
const (
	codecVP8  = "vp8"
	codecVP9  = "vp9"
	codecH264 = "h264"
)

// h264ConstrainedHighFmtp is the only H.264 profile the TeamSpeak client
// renders: Constrained Baseline negotiates but decodes to black, and plain
// Main/High offers are rejected.
const h264ConstrainedHighFmtp = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f"

// EncoderSpec describes one selectable video encoder.
type EncoderSpec struct {
	ID       string `json:"id"`
	Codec    string `json:"codec"`
	FFmpeg   string `json:"ffmpeg"`
	Hardware bool   `json:"hardware"`
}

// encoderOrder is the registry in display order. Hardware entries use VAAPI.
var encoderOrder = []EncoderSpec{
	{ID: "vp8", Codec: codecVP8, FFmpeg: "libvpx"},
	{ID: "vp9", Codec: codecVP9, FFmpeg: "libvpx-vp9"},
	{ID: "h264", Codec: codecH264, FFmpeg: "libx264"},
	{ID: "vp8_vaapi", Codec: codecVP8, FFmpeg: "vp8_vaapi", Hardware: true},
	{ID: "vp9_vaapi", Codec: codecVP9, FFmpeg: "vp9_vaapi", Hardware: true},
	{ID: "h264_vaapi", Codec: codecH264, FFmpeg: "h264_vaapi", Hardware: true},
}

func lookupEncoder(id string) (EncoderSpec, bool) {
	for _, spec := range encoderOrder {
		if spec.ID == id {
			return spec, true
		}
	}
	return EncoderSpec{}, false
}

// softwareEncoderFor returns the software encoder for the same codec family,
// so a hardware fallback never changes what viewers negotiated.
func softwareEncoderFor(codec string) EncoderSpec {
	for _, spec := range encoderOrder {
		if spec.Codec == codec && !spec.Hardware {
			return spec
		}
	}
	return encoderOrder[0]
}

func validCodec(codec string) bool {
	return codec == codecVP8 || codec == codecVP9 || codec == codecH264
}

// codecCapability is what CreatePeer registers and offers for a codec family.
func codecCapability(codec string) webrtc.RTPCodecCapability {
	switch codec {
	case codecVP9:
		return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=0"}
	case codecH264:
		return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264ConstrainedHighFmtp}
	default:
		return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}
	}
}

func getVaapiDevice() string {
	return envOrDefault("VAAPI_DEVICE", "/dev/dri/renderD128")
}

func vaapiDevicePresent() bool {
	info, err := os.Stat(getVaapiDevice())
	return err == nil && !info.IsDir()
}

func hwDecodeEnabled() bool {
	return os.Getenv("VIDEO_HW_DECODE") == "1"
}

// hwInitArgs are global ffmpeg options that open the VAAPI device for
// filters (hwupload) and, when VIDEO_HW_DECODE=1, input decoding. Decode
// falls back to software inside ffmpeg for codecs the GPU cannot decode.
func hwInitArgs(spec EncoderSpec, withDecode bool) []string {
	if !spec.Hardware {
		return nil
	}
	args := []string{"-init_hw_device", "vaapi=va:" + getVaapiDevice(), "-filter_hw_device", "va"}
	if withDecode && hwDecodeEnabled() {
		args = append(args, "-hwaccel", "vaapi", "-hwaccel_device", "va")
	}
	return args
}

// uploadFilter is appended to the software filter chain for hardware encoders.
func uploadFilter(spec EncoderSpec) string {
	if spec.Hardware {
		return "format=nv12,hwupload"
	}
	return "format=yuv420p"
}

// encoderArgs are the codec-specific ffmpeg output options (not the filter
// chain, not the RTP destination).
func encoderArgs(spec EncoderSpec, vBitrate string, lowPower bool) []string {
	gop := strconv.Itoa(envIntOrDefault("VIDEO_GOP", 15))
	rate := []string{
		"-b:v", vBitrate,
		"-maxrate", vBitrate,
		"-bufsize", videoBufsize(vBitrate),
		"-g", gop,
	}

	var args []string
	switch spec.ID {
	case "vp8":
		args = []string{
			"-pix_fmt", "yuv420p",
			"-c:v", "libvpx",
			// Lower = better quality/bit; 6 was for single-core encode. With -threads/-row-mt
			// there is headroom to trade some speed for quality (override via VIDEO_CPU_USED).
			"-cpu-used", envOrDefault("VIDEO_CPU_USED", "4"),
			"-deadline", "realtime",
			// libvpx does not auto-scale across cores without these.
			"-threads", strconv.Itoa(envIntOrDefault("VIDEO_ENCODE_THREADS", runtime.NumCPU())),
			"-row-mt", "1",
			"-lag-in-frames", "0",
			"-error-resilient", "1",
			"-keyint_min", gop,
			"-auto-alt-ref", "0",
		}
	case "vp9":
		args = []string{
			"-pix_fmt", "yuv420p",
			"-c:v", "libvpx-vp9",
			"-cpu-used", envOrDefault("VIDEO_VP9_CPU_USED", "8"),
			"-deadline", "realtime",
			"-threads", strconv.Itoa(envIntOrDefault("VIDEO_ENCODE_THREADS", runtime.NumCPU())),
			"-row-mt", "1",
			"-tile-columns", "2",
			"-frame-parallel", "0",
			"-lag-in-frames", "0",
			"-error-resilient", "1",
			"-keyint_min", gop,
			"-auto-alt-ref", "0",
		}
	case "h264":
		args = []string{
			"-pix_fmt", "yuv420p",
			"-c:v", "libx264",
			"-preset", envOrDefault("VIDEO_X264_PRESET", "veryfast"),
			"-tune", "zerolatency",
			// Constrained High: High profile without B-frames.
			"-profile:v", "high",
			"-bf", "0",
			"-keyint_min", gop,
		}
	case "vp8_vaapi":
		args = []string{"-c:v", "vp8_vaapi"}
	case "vp9_vaapi":
		args = []string{"-c:v", "vp9_vaapi", "-bf", "0"}
	case "h264_vaapi":
		args = []string{"-c:v", "h264_vaapi", "-profile:v", "high", "-bf", "0"}
	}
	if spec.Hardware && lowPower {
		args = append(args, "-low_power", "1")
	}
	if !spec.Hardware && (spec.Codec == codecVP8 || spec.Codec == codecVP9) {
		// libvpx treats -maxrate as a hint and stays VBR unless -minrate
		// matches the target; VP9 was measured at ~2x its bitrate without it.
		rate = append(rate, "-minrate", vBitrate)
	}
	args = append(args, rate...)
	if spec.Codec == codecVP9 {
		// ffmpeg still labels VP9 RTP packetization experimental.
		args = append(args, "-strict", "experimental")
	}
	return args
}

// EncoderProbeResult is one row of GET /encoders.
type EncoderProbeResult struct {
	EncoderSpec
	Available bool   `json:"available"`
	LowPower  bool   `json:"lowPower,omitempty"`
	Error     string `json:"error,omitempty"`
}

// EncoderCapabilities is the cached capability report.
type EncoderCapabilities struct {
	CheckedAt          time.Time            `json:"checkedAt"`
	VaapiDevice        string               `json:"vaapiDevice"`
	VaapiDevicePresent bool                 `json:"vaapiDevicePresent"`
	HwDecode           bool                 `json:"hwDecode"`
	Encoders           []EncoderProbeResult `json:"encoders"`
}

func (c *EncoderCapabilities) find(id string) (EncoderProbeResult, bool) {
	if c == nil {
		return EncoderProbeResult{}, false
	}
	for _, r := range c.Encoders {
		if r.ID == id {
			return r, true
		}
	}
	return EncoderProbeResult{}, false
}

const encoderProbeTimeout = 8 * time.Second

// probeRunner runs one test encode; replaced in tests.
type probeRunner func(ctx context.Context, args []string) (string, error)

func runFFmpegProbe(ctx context.Context, args []string) (string, error) {
	cmd := exec.CommandContext(ctx, getFfmpegPath(), args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// encoderProbeArgs builds a tiny test encode for spec.
func encoderProbeArgs(spec EncoderSpec, lowPower bool) []string {
	args := []string{"-hide_banner", "-nostdin", "-v", "error"}
	// Probe the encoder only; decode capability does not matter for lavfi input.
	args = append(args, hwInitArgs(spec, false)...)
	args = append(args,
		"-f", "lavfi", "-i", "color=c=black:s=320x240:r=30",
		"-frames:v", "3",
		"-vf", uploadFilter(spec),
	)
	args = append(args, encoderArgs(spec, "500k", lowPower)...)
	args = append(args, "-f", "null", "-")
	return args
}

func probeOneEncoder(spec EncoderSpec, devicePresent bool, run probeRunner) EncoderProbeResult {
	res := EncoderProbeResult{EncoderSpec: spec}
	if spec.Hardware && !devicePresent {
		res.Error = "VAAPI device not present"
		return res
	}
	attempts := []bool{false}
	if spec.Hardware {
		// Intel's free iHD driver only exposes low-power (VDEnc) entrypoints.
		attempts = []bool{os.Getenv("VAAPI_LOW_POWER") == "1", os.Getenv("VAAPI_LOW_POWER") != "1"}
	}
	for _, lowPower := range attempts {
		ctx, cancel := context.WithTimeout(context.Background(), encoderProbeTimeout)
		out, err := run(ctx, encoderProbeArgs(spec, lowPower))
		timedOut := ctx.Err() != nil
		cancel()
		if err == nil {
			res.Available = true
			res.LowPower = lowPower
			res.Error = ""
			return res
		}
		switch {
		case timedOut:
			res.Error = fmt.Sprintf("test encode timed out after %s", encoderProbeTimeout)
		case strings.TrimSpace(out) != "":
			res.Error = summarizeFFmpegError(out)
		default:
			res.Error = err.Error()
		}
	}
	return res
}

// probeEncoders test-encodes every registered encoder concurrently.
func probeEncoders(run probeRunner) *EncoderCapabilities {
	devicePresent := vaapiDevicePresent()
	results := make([]EncoderProbeResult, len(encoderOrder))
	var wg sync.WaitGroup
	for i, spec := range encoderOrder {
		wg.Add(1)
		go func(i int, spec EncoderSpec) {
			defer wg.Done()
			results[i] = probeOneEncoder(spec, devicePresent, run)
		}(i, spec)
	}
	wg.Wait()
	return &EncoderCapabilities{
		CheckedAt:          time.Now().UTC(),
		VaapiDevice:        getVaapiDevice(),
		VaapiDevicePresent: devicePresent,
		HwDecode:           hwDecodeEnabled(),
		Encoders:           results,
	}
}

// capabilityCache holds the last probe so routine requests never re-probe.
type capabilityCache struct {
	mu   sync.Mutex
	caps *EncoderCapabilities
	run  probeRunner
}

func (c *capabilityCache) get(refresh bool) *EncoderCapabilities {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.caps == nil || refresh {
		run := c.run
		if run == nil {
			run = runFFmpegProbe
		}
		c.caps = probeEncoders(run)
	}
	return c.caps
}

func (c *capabilityCache) peek() *EncoderCapabilities {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.caps
}
