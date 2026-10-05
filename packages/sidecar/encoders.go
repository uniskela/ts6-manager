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

// GPU backends a hardware encoder can run on. VAAPI (Intel, AMD) opens a DRM
// render node and takes frames uploaded to it; NVENC (NVIDIA) and AMF (AMD,
// native Windows) open the GPU through driver libraries and take system-memory frames.
const (
	backendVAAPI = "vaapi"
	backendNVENC = "nvenc"
	backendAMF   = "amf"
)

// Browsers do not list Constrained High, so a browser answers an offer of
// h264ConstrainedHighFmtp alone with no video codec at all. These are the
// H.264 variants offered to a browser on top of it.
const (
	// Plain High: what Chromium takes (it lists 42001f, 42e01f, 4d001f, f4001f
	// and 64001f). A Constrained High stream is a valid High stream.
	h264HighFmtp = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f"
	// Constrained Baseline: the only H.264 Firefox takes. The stream is still
	// High, so this label is not what is sent; Firefox decodes it all the same
	// (checked with Firefox and Edge on Windows). It is offered last, so a
	// browser that knows High never picks it.
	h264ConstrainedBaselineFmtp = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
)

// browserVideoFallbacks are the extra video codecs offered to a browser viewer
// (the web UI preview) after codec's own capability. TeamSpeak viewers never
// get them: their offer stays exactly what the client is known to render.
func browserVideoFallbacks(codec string) []webrtc.RTPCodecParameters {
	if codec != codecH264 {
		return nil
	}
	return []webrtc.RTPCodecParameters{
		{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264HighFmtp},
			PayloadType:        97,
		},
		{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: h264ConstrainedBaselineFmtp},
			PayloadType:        98,
		},
	}
}

// EncoderSpec describes one selectable video encoder.
type EncoderSpec struct {
	ID       string `json:"id"`
	Codec    string `json:"codec"`
	FFmpeg   string `json:"ffmpeg"`
	Hardware bool   `json:"hardware"`
	// Backend is the GPU backend of a hardware encoder; empty for software.
	Backend string `json:"backend,omitempty"`
}

// encoderOrder is the registry in display order. NVIDIA has no VP8 or VP9
// encoder, so H.264 is its only entry.
var encoderOrder = []EncoderSpec{
	{ID: "vp8", Codec: codecVP8, FFmpeg: "libvpx"},
	{ID: "vp9", Codec: codecVP9, FFmpeg: "libvpx-vp9"},
	{ID: "h264", Codec: codecH264, FFmpeg: "libx264"},
	{ID: "vp8_vaapi", Codec: codecVP8, FFmpeg: "vp8_vaapi", Hardware: true, Backend: backendVAAPI},
	{ID: "vp9_vaapi", Codec: codecVP9, FFmpeg: "vp9_vaapi", Hardware: true, Backend: backendVAAPI},
	{ID: "h264_vaapi", Codec: codecH264, FFmpeg: "h264_vaapi", Hardware: true, Backend: backendVAAPI},
	{ID: "h264_nvenc", Codec: codecH264, FFmpeg: "h264_nvenc", Hardware: true, Backend: backendNVENC},
	{ID: "h264_amf", Codec: codecH264, FFmpeg: "h264_amf", Hardware: true, Backend: backendAMF},
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

// hwInitArgs are global ffmpeg options a hardware encoder needs before the
// input: for VAAPI, the device that filters (hwupload) run on. When
// VIDEO_HW_DECODE=1 they also turn on input decoding on the same GPU (VAAPI,
// or CUDA for NVENC). Decode falls back to software inside ffmpeg for codecs
// the GPU cannot decode.
func hwInitArgs(spec EncoderSpec, withDecode bool) []string {
	switch spec.Backend {
	case backendVAAPI:
		args := []string{"-init_hw_device", "vaapi=va:" + getVaapiDevice(), "-filter_hw_device", "va"}
		if withDecode && hwDecodeEnabled() {
			args = append(args, "-hwaccel", "vaapi", "-hwaccel_device", "va")
		}
		return args
	case backendNVENC:
		// NVENC needs no device: it opens the GPU through the NVIDIA driver.
		// Without -hwaccel_output_format the decoded frames come back to
		// system memory, which is where the filter chain and NVENC want them.
		if withDecode && hwDecodeEnabled() {
			return []string{"-hwaccel", "cuda"}
		}
	}
	return nil
}

// uploadFilter ends the software filter chain with the frame format the
// encoder takes.
func uploadFilter(spec EncoderSpec) string {
	switch spec.Backend {
	case backendVAAPI:
		return "format=nv12,hwupload"
	case backendNVENC, backendAMF:
		// NVENC and AMF upload system-memory frames themselves, without hwupload.
		// The 4:2:0 format is not optional: handed anything else, h264_nvenc
		// switches to High 4:4:4 Predictive and ignores -profile:v, a profile
		// the TeamSpeak client cannot decode.
		return "format=nv12"
	}
	return "format=yuv420p"
}

// encoderArgs are the codec-specific ffmpeg output options (not the filter
// chain, not the RTP destination). cpuUsed > 0 overrides VIDEO_CPU_USED /
// VIDEO_VP9_CPU_USED for software VP8/VP9; hardware encoders ignore it.
func encoderArgs(spec EncoderSpec, vBitrate string, lowPower bool, cpuUsed int) []string {
	gop := strconv.Itoa(envIntOrDefault("VIDEO_GOP", 15))
	rate := []string{
		"-b:v", vBitrate,
		"-maxrate", vBitrate,
		"-bufsize", videoBufsize(vBitrate),
		"-g", gop,
	}

	vp8CPU := envOrDefault("VIDEO_CPU_USED", "4")
	if cpuUsed > 0 {
		vp8CPU = strconv.Itoa(cpuUsed)
	}
	vp9CPU := envOrDefault("VIDEO_VP9_CPU_USED", "8")
	if cpuUsed > 0 {
		vp9CPU = strconv.Itoa(cpuUsed)
	}

	var args []string
	switch spec.ID {
	case "vp8":
		args = []string{
			"-pix_fmt", "yuv420p",
			"-c:v", "libvpx",
			// Lower = better quality/bit; 6 was for single-core encode. With -threads/-row-mt
			// there is headroom to trade some speed for quality (override via VIDEO_CPU_USED).
			"-cpu-used", vp8CPU,
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
			"-cpu-used", vp9CPU,
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
	case "h264_amf":
		// Constrained High, using shared bitrate/GOP settings below.
		args = []string{"-c:v", "h264_amf", "-profile:v", "high", "-bf", "0"}
	case "h264_nvenc":
		args = []string{
			"-c:v", "h264_nvenc",
			// Constrained High, as for the other H.264 encoders.
			"-profile:v", "high",
			// p4 with the low-latency tune is NVENC's balanced real-time
			// setting; zerolatency drops the frame of reordering delay it
			// would otherwise keep.
			"-preset", envOrDefault("VIDEO_NVENC_PRESET", "p4"),
			"-tune", "ll",
			"-rc", "cbr",
			"-zerolatency", "1",
			"-bf", "0",
		}
	}
	if spec.Backend == backendVAAPI && lowPower {
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
	// Detail is the raw ffmpeg reason when Error is a friendlier summary of it.
	Detail string `json:"detail,omitempty"`
	// Attempts are the test encodes run, in order, so the UI can show the
	// exact ffmpeg command and what it printed. Empty when the probe was
	// skipped without running ffmpeg (e.g. no VAAPI device).
	Attempts []EncoderProbeAttempt `json:"attempts,omitempty"`
	// Skipped is why ffmpeg was not run at all; empty when it ran.
	Skipped string `json:"skipped,omitempty"`
}

// EncoderProbeAttempt is one ffmpeg test encode of a probe.
type EncoderProbeAttempt struct {
	Command  string `json:"command"`
	LowPower bool   `json:"lowPower,omitempty"`
	OK       bool   `json:"ok"`
	// Result is how ffmpeg ended: "exit 0", "exit status 1", a timeout, or
	// the error that kept it from starting.
	Result string `json:"result"`
	// Output is ffmpeg's combined stdout/stderr, trimmed to its tail.
	Output string `json:"output,omitempty"`
}

// maxProbeOutput caps the ffmpeg output kept per attempt; the tail is what
// carries the failure.
const maxProbeOutput = 4000

func probeOutputTail(out string) string {
	out = strings.TrimSpace(strings.ReplaceAll(out, "\r\n", "\n"))
	if len(out) > maxProbeOutput {
		out = "…" + out[len(out)-maxProbeOutput:]
	}
	return urlPattern.ReplaceAllString(out, "<source>")
}

// probeCommandLine renders args as a copy-pasteable shell command.
func probeCommandLine(args []string) string {
	parts := make([]string, 0, len(args)+1)
	for _, a := range append([]string{getFfmpegPath()}, args...) {
		if a == "" || strings.ContainsAny(a, " \t'\"\\$`;&|<>()*?[]#~!{}") {
			a = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
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
	args = append(args, encoderArgs(spec, "500k", lowPower, 0)...)
	args = append(args, "-f", "null", "-")
	return args
}

func probeOneEncoder(spec EncoderSpec, devicePresent bool, run probeRunner) EncoderProbeResult {
	res := EncoderProbeResult{EncoderSpec: spec}
	if spec.Backend == backendVAAPI && !devicePresent {
		res.Error = "VAAPI device not present"
		res.Skipped = fmt.Sprintf("VAAPI device %s not present", getVaapiDevice())
		return res
	}
	attempts := []bool{false}
	if spec.Backend == backendVAAPI {
		// Intel's free iHD driver only exposes low-power (VDEnc) entrypoints.
		attempts = []bool{os.Getenv("VAAPI_LOW_POWER") == "1", os.Getenv("VAAPI_LOW_POWER") != "1"}
	}
	for _, lowPower := range attempts {
		ctx, cancel := context.WithTimeout(context.Background(), encoderProbeTimeout)
		args := encoderProbeArgs(spec, lowPower)
		out, err := run(ctx, args)
		timedOut := ctx.Err() != nil
		cancel()
		attempt := EncoderProbeAttempt{
			Command:  probeCommandLine(args),
			LowPower: lowPower,
			OK:       err == nil,
			Result:   "exit 0",
			Output:   probeOutputTail(out),
		}
		switch {
		case timedOut:
			attempt.Result = fmt.Sprintf("timed out after %s", encoderProbeTimeout)
		case err != nil:
			attempt.Result = err.Error()
		}
		res.Attempts = append(res.Attempts, attempt)
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
			if reason := nvencMissingReason(spec, out); reason != "" {
				res.Error, res.Detail = reason, res.Error
			}
		default:
			res.Error = err.Error()
		}
	}
	return res
}

// nvencDriverMissing are ffmpeg messages meaning the host has no usable NVIDIA
// GPU or driver, as opposed to a problem with the test encode itself. ffmpeg
// loads the driver libraries only when the encoder opens, so a GPU-less host
// fails there and ffmpeg appends its generic "maybe incorrect parameters"
// hint, which is misleading here.
var nvencDriverMissing = []string{
	"Cannot load libcuda",
	"Cannot load libnvidia-encode",
	"No NVENC capable devices found",
	"CUDA_ERROR_NO_DEVICE",
	"no CUDA-capable device",
}

// nvencMissingReason is a short reason for an NVENC probe that failed because
// no NVIDIA GPU or runtime is present, or "" for any other failure.
func nvencMissingReason(spec EncoderSpec, out string) string {
	if spec.Backend != backendNVENC {
		return ""
	}
	for _, marker := range nvencDriverMissing {
		if strings.Contains(out, marker) {
			return "NVIDIA GPU/runtime not present"
		}
	}
	return ""
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
