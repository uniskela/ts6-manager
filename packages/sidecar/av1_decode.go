package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// FFmpeg 5.1 opens AV1 with libdav1d, a software decoder that ignores
// -hwaccel, so an AV1 source decodes on the CPU even with VIDEO_HW_DECODE=1 on
// a GPU that could decode it. FFmpeg's own AV1 decoder ("av1") does use
// -hwaccel, but has no software path: on a GPU that cannot decode AV1 it fails
// ("Your platform doesn't support hardware accelerated AV1 decoding") and the
// stream never starts. So it is forced only for an AV1 source, only when the
// stream decodes on the GPU, and only after a test decode on that GPU passed.
// If a stream still fails to start with it, the stream starts again on
// libdav1d (encoderAttempt.afterHardwareFailure).
//
// A GPU can list AV1 decoding and still fail it: Debian's free Intel driver
// (intel-media-va-driver) does on Alder Lake, where every frame fails with
// "internal decoding error" and FFmpeg exits or crashes (Debian #1087837,
// intel/media-driver#1921). The test decode runs FFmpeg as its own process,
// so such a crash only marks AV1 decoding unsupported.

// av1ProbeSample is five frames of AV1 (Main profile, 8-bit 4:2:0, 320x180)
// made from FFmpeg's test pattern with Debian bookworm's FFmpeg 5.1:
//
//	ffmpeg -f lavfi -i testsrc=size=320x180:rate=25:duration=0.2 \
//	  -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p -g 5 -b:v 100k -f ivf av1_probe.ivf
//
//go:embed av1_probe.ivf
var av1ProbeSample []byte

const (
	hwaccelVAAPI = "vaapi"
	hwaccelCUDA  = "cuda"
)

// AV1DecodeProbe is the result of one test decode of AV1 on a GPU.
type AV1DecodeProbe struct {
	Hwaccel   string `json:"hwaccel"`
	Device    string `json:"device,omitempty"`
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
	Command   string `json:"command,omitempty"`
}

// av1DecodeHwaccel is the hwaccel a stream with this encoder decodes on when
// VIDEO_HW_DECODE=1 (see hwInitArgs), and its device; "" when the encoder
// decodes on the CPU.
func av1DecodeHwaccel(spec EncoderSpec) (hwaccel, device string) {
	switch spec.Backend {
	case backendVAAPI:
		return hwaccelVAAPI, getVaapiDevice()
	case backendNVENC:
		return hwaccelCUDA, ""
	}
	return "", ""
}

// av1ProbeArgs decodes the sample at path with FFmpeg's own AV1 decoder on
// hwaccel. -xerror and -v error make a failed frame fail the decode.
func av1ProbeArgs(hwaccel, device, path string) []string {
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-xerror"}
	if hwaccel == hwaccelVAAPI {
		args = append(args, "-init_hw_device", "vaapi=va:"+device, "-hwaccel", "vaapi", "-hwaccel_device", "va")
	} else {
		args = append(args, "-hwaccel", hwaccel)
	}
	return append(args, "-c:v", "av1", "-i", path, "-f", "null", "-")
}

// runAV1DecodeProbe test-decodes the embedded sample on hwaccel. AV1 decoding
// is available only if FFmpeg exits cleanly and reports no error: a crash, a
// timeout or any failed frame mean unavailable, with the reason.
func runAV1DecodeProbe(run probeRunner, hwaccel, device string) AV1DecodeProbe {
	res := AV1DecodeProbe{Hwaccel: hwaccel, Device: device}
	if hwaccel == hwaccelVAAPI {
		if info, err := os.Stat(device); err != nil || info.IsDir() {
			res.Error = fmt.Sprintf("VAAPI device %s not present", device)
			return res
		}
	}
	sample, err := writeAV1ProbeSample()
	if err != nil {
		res.Error = fmt.Sprintf("write test sample: %v", err)
		return res
	}
	defer os.Remove(sample)

	ctx, cancel := context.WithTimeout(context.Background(), encoderProbeTimeout)
	defer cancel()
	args := av1ProbeArgs(hwaccel, device, sample)
	res.Command = probeCommandLine(args)
	out, err := run(ctx, args)
	reason := summarizeFFmpegError(out)
	switch {
	case ctx.Err() != nil:
		res.Error = fmt.Sprintf("test decode timed out after %s", encoderProbeTimeout)
	case err != nil && reason != "":
		res.Error = fmt.Sprintf("%s (%v)", reason, err)
	case err != nil:
		res.Error = err.Error()
	case reason != "":
		res.Error = reason
	default:
		res.Available = true
	}
	return res
}

func writeAV1ProbeSample() (string, error) {
	f, err := os.CreateTemp("", "av1-probe-*.ivf")
	if err != nil {
		return "", err
	}
	_, werr := f.Write(av1ProbeSample)
	cerr := f.Close()
	if err := errors.Join(werr, cerr); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// av1DecodeCache keeps one test decode per hwaccel and device: the answer does
// not change while the sidecar runs. GET /encoders?refresh=1 runs them again.
type av1DecodeCache struct {
	probeMu sync.Mutex
	mu      sync.Mutex
	results map[string]AV1DecodeProbe
}

func (c *av1DecodeCache) get(run probeRunner, hwaccel, device string, refresh bool) AV1DecodeProbe {
	key := hwaccel + "|" + device
	c.mu.Lock()
	r, ok := c.results[key]
	c.mu.Unlock()
	if ok && !refresh {
		return r
	}

	// Serialize test processes, but leave published results available to streams
	// while diagnostics refreshes a potentially slow or crashing driver probe.
	c.probeMu.Lock()
	defer c.probeMu.Unlock()
	c.mu.Lock()
	r, ok = c.results[key]
	c.mu.Unlock()
	if ok && !refresh {
		return r
	}
	r = runAV1DecodeProbe(run, hwaccel, device)
	if r.Available {
		log.Printf("[Probe] AV1 decodes on the GPU (%s)", hwaccel)
	} else {
		log.Printf("[Probe] AV1 does not decode on the GPU (%s): %s; AV1 sources decode on the CPU", hwaccel, r.Error)
	}
	c.mu.Lock()
	if c.results == nil {
		c.results = map[string]AV1DecodeProbe{}
	}
	c.results[key] = r
	c.mu.Unlock()
	return r
}

// probeAll test-decodes AV1 on each GPU the capability report found:
// the VAAPI device when present, and CUDA when NVENC works.
func (c *av1DecodeCache) probeAll(run probeRunner, caps *EncoderCapabilities, refresh bool) []AV1DecodeProbe {
	out := []AV1DecodeProbe{}
	if caps.VaapiDevicePresent {
		out = append(out, c.get(run, hwaccelVAAPI, caps.VaapiDevice, refresh))
	}
	if nvenc, ok := caps.find("h264_nvenc"); ok && nvenc.Available {
		out = append(out, c.get(run, hwaccelCUDA, "", refresh))
	}
	return out
}

// Video codec families the backend may name for a source (SourceRequest.VideoCodec).
var knownVideoCodecs = map[string]bool{"": true, "av1": true, "vp9": true, "h264": true}

func validVideoCodec(codec string) error {
	if !knownVideoCodecs[codec] {
		return fmt.Errorf("unknown video codec %q", codec)
	}
	return nil
}

const localCodecProbeTimeout = 5 * time.Second

// sourceVideo is the codec of a source's video and the index of that stream
// in the first input, where FFmpeg's decode errors name it ("#0:<index>").
type sourceVideo struct {
	codec  string
	stream int
}

// probeLocalVideo reads the codec and stream index of a local file's first
// video stream with ffprobe (no codec when it cannot tell). Local only: a
// remote source would need another connection, which some IPTV providers
// refuse.
func probeLocalVideo(path string) sourceVideo {
	abs, err := filepath.Abs(path)
	if err != nil {
		return sourceVideo{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), localCodecProbeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, getFfprobePath(), "-v", "error",
		"-select_streams", "v:0", "-show_entries", "stream=index,codec_name",
		"-of", "csv=p=0", "file:"+abs).Output()
	if err != nil {
		return sourceVideo{}
	}
	return parseProbedVideo(string(out))
}

// parseProbedVideo reads ffprobe's "index,codec_name" line.
func parseProbedVideo(out string) sourceVideo {
	fields := strings.Split(strings.TrimSpace(strings.SplitN(out, "\n", 2)[0]), ",")
	if len(fields) != 2 {
		return sourceVideo{}
	}
	index, err := strconv.Atoi(strings.TrimSpace(fields[0]))
	if err != nil || index < 0 {
		return sourceVideo{}
	}
	return sourceVideo{codec: strings.TrimSpace(fields[1]), stream: index}
}

// localVideo is probeLocalVideo, replaced in tests.
var localVideo = probeLocalVideo

// sourceVideoOf probes local video indexes, or uses backend codec metadata
// for remote inputs. The backend names the codec of
// a YouTube stream it resolved, and YouTube serves AV1 only as video-only
// formats, so that video is stream 0 of its input.
func sourceVideoOf(req SourceRequest) sourceVideo {
	// Codec metadata does not identify a local file's stream index. Probe
	// local inputs even when the caller knows AV1, including reordered audio.
	if req.Source != "" && !isRemoteSource(req.Source) {
		return localVideo(req.Source)
	}
	if req.VideoCodec != "" {
		return sourceVideo{codec: req.VideoCodec}
	}
	return sourceVideo{}
}

// av1GPUDecoder decides whether a stream with spec forces FFmpeg's own AV1
// decoder onto the GPU. It returns the hwaccel to decode on ("" for the
// default decoder), whether the source is AV1 at all, and the AV1 video's
// stream index. The cheap checks come first: nothing is probed for a stream
// that cannot use it.
func (s *Sidecar) av1GPUDecoder(req SourceRequest, spec EncoderSpec) (hwaccel string, isAV1 bool, stream int) {
	if !spec.Hardware || !hwDecodeEnabled() || req.Source == "" {
		return "", false, 0
	}
	hwaccel, device := av1DecodeHwaccel(spec)
	if hwaccel == "" {
		return "", false, 0
	}
	video := sourceVideoOf(req)
	if video.codec != "av1" {
		return "", false, 0
	}
	if !s.caps.av1Decode(hwaccel, device).Available {
		return "", true, video.stream
	}
	return hwaccel, true, video.stream
}

// These diagnostics are emitted by fftools/ffmpeg.c in 5.1, and
// fftools/ffmpeg_dec.c in 6.1 through 9.0.1. Modern FFmpeg includes the
// media type and codec in the input-stream log context; 7+ also includes
// a child decoder context. Match the decoding operation, not generic
// "Invalid data" or network/encoder/filter errors. See testdata/av1-errors.
var legacyDecodeError = regexp.MustCompile(`^Error while decoding stream #0:([0-9]+): .+`)
var modernDecodeError = regexp.MustCompile(`^\[vist#0:([0-9]+)/av1(?: @ [^]\r\n]+)?\] ?(?:\[dec:av1(?: @ [^]\r\n]+)?\] ?)?(?:Decoding error:|Error submitting packet to decoder:) .+`)

func decodeErrorStream(line string) (int, bool) {
	match := legacyDecodeError.FindStringSubmatch(line)
	if match == nil {
		match = modernDecodeError.FindStringSubmatch(line)
	}
	if match == nil {
		return 0, false
	}
	stream, err := strconv.Atoi(match[1])
	return stream, err == nil
}

// recordDecodeDiagnostics runs under tailBuffer.mu. Keep complete failure
// evidence separately from the rolling tail. FFmpeg may write a line in
// multiple chunks, or enough output in one Write to overflow the tail.
func (t *tailBuffer) recordDecodeDiagnostics(p []byte) {
	for _, b := range p {
		if b == '\n' || b == '\r' {
			t.recordDecodeLine()
			t.diagnosticPending = t.diagnosticPending[:0]
			t.diagnosticOverflow = false
			continue
		}
		if len(t.diagnosticPending) < 4096 {
			t.diagnosticPending = append(t.diagnosticPending, b)
		} else {
			t.diagnosticOverflow = true
		}
	}
}

func (t *tailBuffer) recordDecodeLine() {
	if t.diagnosticOverflow {
		return
	}
	line := string(t.diagnosticPending)
	if stream, ok := decodeErrorStream(line); ok {
		if t.decodeFailures == nil {
			t.decodeFailures = make(map[int]string)
		}
		// Bound retained evidence even for a malicious input with many streams.
		if _, exists := t.decodeFailures[stream]; !exists && len(t.decodeFailures) < 1024 {
			t.decodeFailures[stream] = line
		}
		if _, exists := t.decodeFailures[stream]; exists {
			if t.decodeFailureCount == nil {
				t.decodeFailureCount = make(map[int]int)
			}
			t.decodeFailureCount[stream]++
		}
	}
}

func av1DecodeFailureReason(t *tailBuffer, stream int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if line := t.decodeFailures[stream]; line != "" {
		return summarizeFFmpegError(line)
	}
	// A final stderr write need not end in a newline.
	if !t.diagnosticOverflow {
		if n, ok := decodeErrorStream(string(t.diagnosticPending)); ok && n == stream {
			return summarizeFFmpegError(string(t.diagnosticPending))
		}
	}
	return ""
}

// av1DecodeFailed reports a decode error from the selected input video
// stream, including evidence already evicted from the stderr tail. One error
// is enough for an ffmpeg that then exited with a failure. For one that is
// still running, see av1DecodeFailing.
func av1DecodeFailed(t *tailBuffer, stream int) bool {
	return av1DecodeFailureReason(t, stream) != ""
}

// av1SustainedDecodeErrors is how many decode errors of the video stream mean
// a running ffmpeg is not decoding it on the GPU. A GPU that cannot decode
// the source fails every frame and passes this within half a second; a
// damaged frame or two in a stream that plays on does not.
const av1SustainedDecodeErrors = 10

// av1DecodeFailing reports sustained decode errors from the selected input
// video stream: the reason to stop a running ffmpeg and decode on the CPU.
func av1DecodeFailing(t *tailBuffer, stream int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.decodeFailureCount[stream] >= av1SustainedDecodeErrors
}

// av1DecodeWatchWindow is how long after a launch with FFmpeg's own AV1
// decoder failed frames still mean the GPU cannot decode the source. Longer
// than the hardware startup check, for remote sources that take a while to
// open. A variable for tests.
var av1DecodeWatchWindow = 15 * time.Second

// restartOnLibdav1dIfAV1Fails watches one GPU-decoding generation for
// av1DecodeWatchWindow and starts the stream once on a software decoder if
// the GPU does not decode it: sustained decode errors of the video stream
// while ffmpeg runs on, or one such error before ffmpeg exits with a failure.
// Completion and a polling tick use the same decision path so scheduling
// cannot decide whether a qualifying failure receives its retry.
func (s *Sidecar) restartOnLibdav1dIfAV1Fails(req SourceRequest, hwaccel string, stream int, gen uint64, done <-chan struct{}, tail *tailBuffer) {
	deadline := time.NewTimer(av1DecodeWatchWindow)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	s.watchAV1DecodeFailure(req, hwaccel, stream, gen, done, tail, tick.C, deadline.C, s.startFFmpegLocked)
}

// The clock channels let concurrency tests drive the precise ordering of
// process completion, detection, cancellation and stream replacement.
func (s *Sidecar) watchAV1DecodeFailure(req SourceRequest, hwaccel string, stream int, gen uint64, done <-chan struct{}, tail *tailBuffer, ticks, deadline <-chan time.Time, restart func(SourceRequest) (EncoderSession, error)) {
	for {
		select {
		case <-done:
			// A nonzero exit can be the decoder failure, not an EOF.
		case <-deadline:
			// Completion may have raced the timer. A failure that completed
			// inside the window still owns its retry, regardless of select.
			if !exited(done) || (!tail.decodeDeadline.IsZero() && !tail.processExitedAt.Before(tail.decodeDeadline)) {
				return
			}
		case <-ticks:
		}
		if !tail.decodeDeadline.IsZero() && time.Now().After(tail.decodeDeadline) && (!exited(done) || !tail.processExitedAt.Before(tail.decodeDeadline)) {
			return
		}
		if exited(done) {
			// One decode error before a failed exit is a decoder that gave
			// up. retryAV1DecodeFailure leaves a clean exit alone.
			if !av1DecodeFailed(tail, stream) {
				return
			}
		} else if !av1DecodeFailing(tail, stream) {
			// Still running: only sustained errors stop it. A stream that
			// recovers from a damaged frame stays on the GPU.
			continue
		}
		// Claim the terminal decision before waiting for ffmpegLock or Kill.
		// Process completion may cross the window boundary in the meantime.
		tail.retryPending.Store(true)
		s.retryAV1DecodeFailure(req, hwaccel, stream, gen, done, tail, restart)
		return
	}
}

func (s *Sidecar) retryAV1DecodeFailure(req SourceRequest, hwaccel string, stream int, gen uint64, done <-chan struct{}, tail *tailBuffer, restart func(SourceRequest) (EncoderSession, error)) {
	s.ffmpegLock.Lock()
	defer s.ffmpegLock.Unlock()
	if atomic.LoadUint64(&s.ffmpegGen) != gen {
		return
	}
	if !exited(done) {
		// Keep ownership until Wait has completed. In particular, do not
		// replace s.ffmpeg and leave the previous process alive or unreaped.
		if s.ffmpeg == nil || s.ffmpeg.Process == nil {
			return
		}
		s.ffmpeg.Process.Kill()
		<-done
	}
	// Completion publishes the exit result before closing done. Even when
	// EOF races with detection/Kill, successful completion must not replay.
	if tail.processError == nil {
		return
	}
	reason := av1DecodeFailureReason(tail, stream)
	if reason == "" {
		reason = "AV1 GPU decoder failed"
	}
	log.Printf("[FFmpeg] AV1 did not decode on the GPU (%s): %s; starting again with a software AV1 decoder", hwaccel, reason)
	req.av1FallbackReason = reason
	if _, err := restart(req); err != nil {
		log.Printf("[FFmpeg] Restart on software AV1 decoder failed: %v", err)
		// Validation can fail before restart changes the generation. Publish
		// that terminal error rather than leaving a pending retry running.
		s.statusMu.Lock()
		if s.encoder.gen == gen && atomic.LoadUint64(&s.ffmpegGen) == gen {
			s.encoder.State = "exited"
			s.encoder.ExitError = err.Error()
		}
		s.statusMu.Unlock()
	}
}

// exited reports whether the ffmpeg behind done has exited, without waiting.
func exited(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}

// decoderLabel names the video decoder a launch uses, for the stream state:
// only for AV1 sources, where it is not obvious ("" otherwise).
func decoderLabel(a encoderAttempt) string {
	switch {
	case a.av1Hwaccel != "":
		return "av1 (" + a.av1Hwaccel + ")"
	case a.av1SoftwareDecoder != "":
		return a.av1SoftwareDecoder
	case a.av1Source:
		return "software"
	}
	return ""
}
