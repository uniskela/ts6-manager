package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var defaultStunServers = []string{
	"stun:49.13.204.141:3478",
	"stun:176.58.93.154:3478",
	"stun:185.40.234.113:3478",
	"stun:68.183.90.120:3478",
	"stun:45.159.97.233:3478",
	"stun:172.105.166.103:3478",
	"stun:172.237.28.183:3478",
	"stun:208.72.155.133:3478",
	"stun:stun.l.google.com:19302",
}

// stunGatherTimeout bounds how long ICE gathering waits on a STUN server.
//
// CreatePeer answers a viewer only once gathering has completed, and gathering
// completes only when every STUN request has been answered or has timed out.
// pion's default timeout is five seconds, so a single server in the list that
// no longer answers held every viewer at "waiting to be let in" for exactly
// five seconds. A reachable server answers in a fraction of a second, so this
// keeps the server-reflexive candidates remote viewers need while capping what
// an unreachable one costs.
const stunGatherTimeout = 1 * time.Second

func getStunServers() []string {
	if env := os.Getenv("STUN_SERVERS"); env != "" {
		return strings.Split(env, ",")
	}
	return defaultStunServers
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getFfmpegPath() string {
	return envOrDefault("FFMPEG_PATH", "ffmpeg")
}

func getMusicDir() string {
	return envOrDefault("MUSIC_DIR", "/data/music")
}

// Portable references contain one allowlisted filename, never an OS path or URL escapes.
var musicSourceName = regexp.MustCompile(`^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,200}|\.stream-[0-9]+\.mp4)$`)

func resolveMusicSource(source string) (string, error) {
	if !strings.HasPrefix(source, "music://") {
		return source, nil
	}
	name := strings.TrimPrefix(source, "music://")
	if !musicSourceName.MatchString(name) {
		return "", fmt.Errorf("music source must be a filename under MUSIC_DIR")
	}
	root, err := filepath.Abs(getMusicDir())
	if err != nil {
		return "", fmt.Errorf("invalid MUSIC_DIR: %w", err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("invalid MUSIC_DIR: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(root, name))
	if err != nil {
		return "", fmt.Errorf("local music source not found: %w", err)
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("local source must be under MUSIC_DIR")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("local music source must be a regular file")
	}
	return resolved, nil
}

// resolveSource validates local paths and translates portable shared-file references.
func resolveSource(source string) (string, error) {
	if strings.HasPrefix(source, "music://") {
		return resolveMusicSource(source)
	}
	if source == "" || isRemoteSource(source) {
		return source, nil
	}
	absSource, err := filepath.Abs(source)
	if err != nil {
		return "", fmt.Errorf("invalid source path: %w", err)
	}
	absMusic, err := filepath.Abs(getMusicDir())
	if err != nil {
		return "", fmt.Errorf("invalid MUSIC_DIR: %w", err)
	}
	if absSource != absMusic && !strings.HasPrefix(absSource, absMusic+string(os.PathSeparator)) {
		return "", fmt.Errorf("local source must be under MUSIC_DIR")
	}
	return source, nil
}

func validSource(source string) error {
	_, err := resolveSource(source)
	return err
}

// validAudioSource checks the optional second input: a remote URL carrying
// the audio of a remote, video-only source. Nothing else comes in two parts.
func validAudioSource(source, audioSource string) error {
	if audioSource == "" {
		return nil
	}
	if !isRemoteSource(audioSource) || !isRemoteSource(source) {
		return fmt.Errorf("audioSource needs an http(s) source and an http(s) audio URL")
	}
	return nil
}

// parseBitrateKbps parses ffmpeg-style bitrate strings ("4500k", "20000K",
// or a bare number already in kbps) into kbps. Returns 0 if unparseable.
func parseBitrateKbps(s string) int {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(strings.TrimSuffix(s, "k"), "K")
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

// videoBufsize picks the VP8 rate-control buffer size for a given target
// bitrate. Scale to ~2x the target bitrate unless VIDEO_BUFSIZE overrides.
func videoBufsize(vBitrate string) string {
	if v := os.Getenv("VIDEO_BUFSIZE"); v != "" {
		return v
	}
	if kbps := parseBitrateKbps(vBitrate); kbps > 0 {
		return fmt.Sprintf("%dk", kbps*2)
	}
	return "500k"
}

func debugLogsEnabled() bool {
	return os.Getenv("SIDECAR_DEBUG_LOGS") == "1"
}

func debugf(format string, args ...any) {
	if debugLogsEnabled() {
		log.Printf(format, args...)
	}
}

// quoteErr keeps a viewer-controlled parser error on one log record.
// ReplaceAll of both newline characters is the sanitizer Sonar recognizes;
// Quote also escapes the other control characters.
func quoteErr(err error) string {
	quoted := strconv.Quote(err.Error())
	return strings.ReplaceAll(strings.ReplaceAll(quoted, "\n", "_"), "\r", "_")
}

// NTP epoch offset: seconds between 1900-01-01 and 1970-01-01
const ntpEpochOffset = 2208988800

func toNTPTime(t time.Time) uint64 {
	secs := uint64(t.Unix()) + ntpEpochOffset
	frac := uint64(t.Nanosecond()) * (1 << 32) / 1e9
	return secs<<32 | frac
}

func isVP8KeyframeStart(payload []byte) bool {
	if len(payload) < 2 {
		return false
	}
	i := 0

	// VP8 payload descriptor
	b0 := payload[i]
	x := (b0 & 0x80) != 0
	s := (b0 & 0x10) != 0
	pid := b0 & 0x0F
	i++

	if !s || pid != 0 {
		return false
	}

	if x {
		if len(payload) <= i {
			return false
		}
		ext := payload[i]
		i++

		if (ext & 0x80) != 0 {
			if len(payload) <= i {
				return false
			}

			// M bit => 16-bit PictureID, else 8-bit
			if (payload[i] & 0x80) != 0 {
				i += 2
			} else {
				i += 1
			}
		}

		// L: TL0PICIDX present
		if (ext & 0x40) != 0 {
			i += 1
		}

		// T or K => one extra octet
		if (ext&0x20) != 0 || (ext&0x10) != 0 {
			i += 1
		}
	}
	if len(payload) <= i {
		return false
	}
	// VP8 frame tag: bit 0 == frame type
	// 0 = keyframe, 1 = interframe
	return (payload[i] & 0x01) == 0
}

func rtpElapsed(ts, base, clockRate uint32) time.Duration {
	return time.Duration((uint64(ts-base) * uint64(time.Second)) / uint64(clockRate))
}

func smoothDuration(prev, sample time.Duration) time.Duration {
	if prev <= 0 {
		return sample
	}
	return (prev*9 + sample) / 10
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func (s *Sidecar) resetSyncTiming() {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	// Keep the run's clock line, which the next run's timestamps carry on.
	s.prevVideoLine = clockLine{}
	s.prevAudioLine = clockLine{}
	s.prevLineMinElapsed = 0
	if s.streamBaseSet {
		if s.videoTiming.initialized {
			s.prevVideoLine = clockLine{valid: true, base: s.videoTiming.baseRTP, wall: s.streamBaseWall}
			s.prevLineMinElapsed = max(s.prevLineMinElapsed, s.videoRTP.leadOn(s.prevVideoLine))
		}
		if s.audioTiming.initialized {
			s.prevAudioLine = clockLine{valid: true, base: s.audioTiming.baseRTP, wall: s.streamBaseWall}
			s.prevLineMinElapsed = max(s.prevLineMinElapsed, s.audioRTP.leadOn(s.prevAudioLine))
		}
	}
	s.streamBaseWall = time.Time{}
	s.streamBaseSet = false
	s.videoTiming = TrackTiming{}
	s.audioTiming = TrackTiming{}
	// The next FFmpeg run starts its RTP numbering afresh.
	s.videoRTP.markRestart()
	s.audioRTP.markRestart()
	s.h264Params.clear()
}

func (s *Sidecar) drainRTPQueues() {
	for {
		select {
		case <-s.videoQueue:
		default:
			goto drainAudio
		}
	}

drainAudio:
	for {
		select {
		case <-s.audioQueue:
		default:
			return
		}
	}
}

func (s *Sidecar) resetPeerStreamState() {
	s.peersLock.RLock()
	defer s.peersLock.RUnlock()

	for _, peer := range s.peers {
		peer.mu.Lock()
		peer.Started = false
		peer.mu.Unlock()
	}
}

// trackTimingsLocked returns kind's timing, the other track's, and kind's RTP
// clock rate. current is nil for an unknown kind. Callers hold timingMu.
func (s *Sidecar) trackTimingsLocked(kind string) (current, other *TrackTiming, clockRate uint32) {
	switch kind {
	case "video":
		return &s.videoTiming, &s.audioTiming, 90000
	case "audio":
		return &s.audioTiming, &s.videoTiming, 48000
	}
	return nil, nil, 0
}

// playoutOffsetLocked is how far behind the shared clock kind's track is
// sent: the later of the two tracks' latencies, plus the playout buffer.
// Both tracks are sent at the same offset, which is what lines them up.
//
// Until the other track has started, assume it is as late as allowed. The
// two encoders do not start together — video's first frame trails the
// audio by the decoder's frame-threading delay, and a hardware encoder adds
// its start-up on top — so sending the first track alone would put it out
// of step, and then stall it when the other appears and the offset jumps.
// The wait is bounded: a source with no audio stops holding its video once
// maxTrackDelay has passed. Callers hold timingMu.
func (s *Sidecar) playoutOffsetLocked(kind string, current, other *TrackTiming, at time.Time) time.Duration {
	target := current.latency
	switch {
	case other.initialized:
		target = maxDuration(target, other.latency)
	case at.Sub(s.streamBaseWall) < s.maxTrackDelay:
		target = s.maxTrackDelay
	}
	offset := target + s.syncBuffer
	if kind == "video" {
		offset += s.videoBias
	}
	return offset
}

// recordFrame records the arrival of a packet from FFmpeg and returns its
// place on the shared clock: when its media time left FFmpeg, had it been
// delayed no more than the earliest packet was.
//
// Latency is measured here, at arrival, never in the forwarding loop. A loop
// that measures after its own sleep counts that sleep as latency and sleeps
// longer next time, so the hold climbs to its cap whatever the real skew is:
// measured with this image's FFmpeg, the previous pacer settled at
// SYNC_MAX_DELAY_MS plus the playout buffer on every stream.
//
// Both tracks are assumed to start at media time zero, so the earliest first
// packet marks when media time zero left FFmpeg. Packets of one frame share a
// timestamp and are measured once.
func (s *Sidecar) recordFrame(kind string, ts uint32, arrived time.Time) time.Time {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, _, clockRate := s.trackTimingsLocked(kind)
	if current == nil {
		return arrived
	}
	if current.initialized && ts == current.lastTS {
		return current.lastClock
	}

	if !s.streamBaseSet {
		s.streamBaseSet = true
		s.streamBaseWall = arrived
	}
	// A discontinuous RTP clock (IPTV PCR/PTS breaks) is re-based onto the wall
	// clock, or the track would be held at maxTrackDelay. The track keeps the
	// latency measured so far: a break in the source's timestamps says nothing
	// about how far this track trails the other one.
	measured := current.latency
	if s.noteTimestamp(current, ts, arrived, clockRate) {
		current.baseRTP += uint32(uint64(measured) * uint64(clockRate) / uint64(time.Second))
		current.latency = measured
	}

	clock := s.streamBaseWall.Add(rtpElapsed(ts, current.baseRTP, clockRate))

	// Clamped so that one bad timestamp cannot poison the average.
	observedLatency := arrived.Sub(clock)
	if observedLatency < 0 {
		observedLatency = 0
	}
	if observedLatency > s.maxTrackDelay {
		observedLatency = s.maxTrackDelay
	}
	current.latency = smoothDuration(current.latency, observedLatency)

	current.lastTS = ts
	current.lastClock = clock
	return clock
}

// sendTime is when a packet recorded at clock, which arrived at arrived,
// should be forwarded, given what is known about both tracks at now. It is
// asked again while the packet waits, because the answer drops when the
// other track starts. No packet is held longer than maxTrackDelay.
func (s *Sidecar) sendTime(kind string, clock, arrived, now time.Time) time.Time {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, other, _ := s.trackTimingsLocked(kind)
	if current == nil {
		return arrived
	}
	sendAt := clock.Add(s.playoutOffsetLocked(kind, current, other, now))
	if latest := arrived.Add(s.maxTrackDelay); sendAt.After(latest) {
		sendAt = latest
	}
	return sendAt
}

// pacingPoll bounds each sleep of a waiting packet, so a packet held for a
// track that has not started yet is released soon after it starts.
const pacingPoll = 10 * time.Millisecond

// waitToSend blocks until q is due.
func (s *Sidecar) waitToSend(kind string, q queuedPacket) {
	for {
		d := time.Until(s.sendTime(kind, q.clock, q.arrived, time.Now()))
		if d <= 0 {
			return
		}
		time.Sleep(min(d, pacingPoll))
	}
}

// senderReportRTPTime is the RTP timestamp of kind's track that is being sent
// at now, read off the clock both tracks are paced against. Sender Reports
// pair it with now for both tracks, so a receiver that lines the tracks up by
// their reports lines them up by media time.
//
// The last timestamp read from FFmpeg would not do. Video leaves FFmpeg later
// than audio — the decoder's frame threading alone is about half a second on
// a many-core host — and pairing both tracks' latest timestamps with one wall
// time reports that delay as the intended sync, which a receiver would then
// reproduce. ok is false until the track has started.
func (s *Sidecar) senderReportRTPTime(kind string, now time.Time) (ts uint32, ok bool) {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, other, clockRate := s.trackTimingsLocked(kind)
	if current == nil || !s.streamBaseSet || !current.initialized {
		return 0, false
	}
	media := now.Sub(s.streamBaseWall) - s.playoutOffsetLocked(kind, current, other, now)
	// Signed on purpose: before the first packet is due the media time is
	// negative, and uint32 arithmetic wraps it to the right timestamp.
	ticks := int64(media) * int64(clockRate) / int64(time.Second)
	return current.baseRTP + uint32(ticks), true
}

func cloneRTPPacket(src *rtp.Packet) *rtp.Packet {
	raw, err := src.Marshal()
	if err != nil {
		return nil
	}

	dst := &rtp.Packet{}
	if err := dst.Unmarshal(raw); err != nil {
		return nil
	}

	return dst
}

type TrackTiming struct {
	initialized bool
	baseRTP     uint32
	lastRTP     uint32
	latency     time.Duration

	// The frame most recently recorded, so its remaining packets share its
	// place on the clock.
	lastTS    uint32
	lastClock time.Time
}

// queuedPacket is an RTP packet from FFmpeg with its arrival time and its
// place on the shared clock, as recordFrame measured them.
type queuedPacket struct {
	pkt     *rtp.Packet
	arrived time.Time
	clock   time.Time
}

// maxContinuousRTPStep is the largest RTP timestamp step treated as normal
// playout. A larger jump, or a step backwards, is a source-clock break
// (common on live IPTV) rather than a real gap to wait out.
const maxContinuousRTPStep = time.Second

// noteTimestamp keeps a track's RTP clock aligned with the wall clock.
// It reports whether this packet was a discontinuity and the base was reset.
// Caller holds timingMu.
func (s *Sidecar) noteTimestamp(current *TrackTiming, ts uint32, now time.Time, clockRate uint32) bool {
	if !current.initialized {
		current.initialized = true
		current.baseRTP = ts
		current.lastRTP = ts
		return false
	}
	// int32 delta handles a uint32 wrap as a small forward step, and a
	// backwards jump as negative, without treating a 24-hour wrap as a reset.
	step := time.Duration(int64(int32(ts-current.lastRTP))) * time.Second / time.Duration(clockRate)
	current.lastRTP = ts
	if step >= 0 && step <= maxContinuousRTPStep {
		return false
	}
	elapsed := now.Sub(s.streamBaseWall)
	if elapsed < 0 {
		elapsed = 0
	}
	ticks := uint64(elapsed) * uint64(clockRate) / uint64(time.Second)
	current.baseRTP = ts - uint32(ticks)
	current.latency = 0
	return true
}

type createInFlight struct {
	done chan struct{}
	sdp  string
	err  error
}

type Peer struct {
	ID    string
	Codec string
	// Browser is set for a browser viewer, whose offer carries the codec
	// fallbacks a TeamSpeak viewer does not get.
	Browser    bool
	PC         *webrtc.PeerConnection
	VideoTrack *webrtc.TrackLocalStaticRTP
	AudioTrack *webrtc.TrackLocalStaticRTP
	VideoSSRC  uint32
	AudioSSRC  uint32
	Active     bool
	Started    bool
	// checking and connected record how far ICE got, so a viewer that
	// answered but never connected can be told apart from one that played
	// and then left. Guarded by mu.
	checking  bool
	connected bool
	// offerSDP is the offer sent to the viewer, logged if it never connects.
	offerSDP string
	mu       sync.Mutex
	stopSR   chan struct{}
	// pendingICE holds candidates that arrived before the viewer's answer;
	// SetAnswer flushes them. Guarded by mu.
	pendingICE []webrtc.ICECandidateInit
	// videoOutSeq is the RTP sequence number last written on VideoTrack and
	// videoInSeq the stream's own number for that packet. Guarded by mu. They
	// survive stream-gate resets so an H.264 SPS/PPS prefix cannot reuse a
	// sequence SRTP already accepted from this peer.
	videoOutSeq   uint16
	videoInSeq    uint16
	videoOutSeqOK bool
}

// maxPendingICE bounds the candidates held for a peer that has not answered
// yet, so a peer that never answers cannot grow the buffer without limit.
const maxPendingICE = 64

type Sidecar struct {
	peers     map[string]*Peer
	peersLock sync.RWMutex
	creating  map[string]*createInFlight

	videoPort int
	audioPort int
	videoConn *net.UDPConn
	audioConn *net.UDPConn

	// Optional shared ICE UDP mux so Docker can publish one host UDP port for
	// browser WebRTC preview (see WEBRTC_UDP_PORT / WEBRTC_NAT1TO1_IP).
	iceUDPPort      int
	iceUDPConn      *net.UDPConn
	iceUDPMux       ice.UDPMux
	iceAdvertiseIPs []string

	ffmpeg     *exec.Cmd
	ffmpegLock sync.Mutex
	ffmpegGen  uint64
	source     string
	running    bool
	// egress is the current remote source's connection proxy (nil for local
	// files or with SIDECAR_EGRESS_PROXY=off); guarded by ffmpegLock.
	egress *egressProxy

	// streamCodec is the codec family ffmpeg currently packetizes (string).
	streamCodec atomic.Value

	// Encoder session state reported by /stats; guarded by statusMu.
	statusMu sync.Mutex
	encoder  EncoderSession

	caps capabilityCache

	// Encode health for the current ffmpeg run (guarded by statusMu) and RTP
	// queue-full drop counters (atomic, reset per run).
	health        *healthTracker
	rtpVideoDrops uint64
	rtpAudioDrops uint64

	// Atomic counters for RTCP Sender Reports
	videoPktCount   uint64 // atomic
	videOctetCount  uint64 // atomic
	audioPktCount   uint64 // atomic
	audioOctetCount uint64 // atomic

	videoQueue chan queuedPacket
	audioQueue chan queuedPacket

	// Stream pacing / A/V alignment state
	timingMu       sync.Mutex
	streamBaseWall time.Time
	streamBaseSet  bool
	videoTiming    TrackTiming
	audioTiming    TrackTiming
	syncBuffer     time.Duration
	videoBias      time.Duration
	// The most one track is held back to meet the other, and the longest the
	// first track waits for the other to start.
	maxTrackDelay time.Duration

	// Outgoing RTP numbering, kept continuous across FFmpeg restarts.
	videoRTP rtpContinuity
	audioRTP rtpContinuity
	// The previous run's clock lines, guarded by timingMu.
	prevVideoLine clockLine
	prevAudioLine clockLine
	// prevLineMinElapsed is how far along the previous lines the next run
	// must start, so that neither track steps back from its last packet.
	prevLineMinElapsed time.Duration

	// Latest H.264 SPS/PPS from the live RTP path, for late-joining peers.
	h264Params h264ParamCache
}

func NewSidecar() *Sidecar {
	s := &Sidecar{
		peers:         make(map[string]*Peer),
		creating:      make(map[string]*createInFlight),
		syncBuffer:    time.Duration(envIntOrDefault("SYNC_PLAYOUT_BUFFER_MS", 50)) * time.Millisecond,
		videoBias:     time.Duration(envIntOrDefault("SYNC_VIDEO_BIAS_MS", 0)) * time.Millisecond,
		maxTrackDelay: time.Duration(envIntOrDefault("SYNC_MAX_DELAY_MS", 1000)) * time.Millisecond,
		// Room for maxTrackDelay of a 4K stream: at 20 Mbit/s and 1200-byte
		// packets that is some 2000 packets a second.
		videoQueue: make(chan queuedPacket, envIntOrDefault("VIDEO_QUEUE_SIZE", 4096)),
		audioQueue: make(chan queuedPacket, envIntOrDefault("AUDIO_QUEUE_SIZE", 2048)),
	}
	s.videoRTP.clockRate = 90000
	s.audioRTP.clockRate = 48000
	s.streamCodec.Store(codecVP8)
	return s
}

func (s *Sidecar) currentCodec() string {
	if c, ok := s.streamCodec.Load().(string); ok && c != "" {
		return c
	}
	return codecVP8
}

func (s *Sidecar) StartRTP() error {
	var err error

	s.videoConn, err = net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		return fmt.Errorf("bind video UDP: %w", err)
	}
	_ = s.videoConn.SetReadBuffer(envIntOrDefault("VIDEO_RTP_READ_BUFFER", 4*1024*1024))
	s.videoPort = s.videoConn.LocalAddr().(*net.UDPAddr).Port

	s.audioConn, err = net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		return fmt.Errorf("bind audio UDP: %w", err)
	}
	_ = s.audioConn.SetReadBuffer(envIntOrDefault("AUDIO_RTP_READ_BUFFER", 1*1024*1024))
	s.audioPort = s.audioConn.LocalAddr().(*net.UDPAddr).Port

	log.Printf("[RTP] Video port: %d, Audio port: %d", s.videoPort, s.audioPort)
	s.running = true

	go s.readVideoRTP()
	go s.readAudioRTP()
	go s.processVideoRTP()
	go s.processAudioRTP()

	return nil
}

func (s *Sidecar) readVideoRTP() {
	buf := make([]byte, 1500)
	pkt := &rtp.Packet{}
	count := 0

	for s.running {
		n, err := s.videoConn.Read(buf)
		arrived := time.Now()
		if err != nil {
			if s.running {
				log.Printf("[RTP] Video read error: %v", err)
			}
			return
		}

		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		atomic.AddUint64(&s.videoPktCount, 1)
		atomic.AddUint64(&s.videOctetCount, uint64(len(pkt.Payload)))

		count++
		if count <= 3 || count%600 == 0 {
			debugf("[VIDEO] #%d ts=%d (%.3fs) marker=%v", count, pkt.Timestamp, float64(pkt.Timestamp)/90000.0, pkt.Marker)
		}

		cloned := cloneRTPPacket(pkt)
		if cloned == nil {
			continue
		}

		s.continueRTP("video", cloned, s.currentCodec(), arrived)
		q := queuedPacket{pkt: cloned, arrived: arrived, clock: s.recordFrame("video", cloned.Timestamp, arrived)}
		select {
		case s.videoQueue <- q:
		default:
			atomic.AddUint64(&s.rtpVideoDrops, 1)
			if count%120 == 0 {
				log.Printf("[VIDEO] queue full, dropping packet ts=%d", cloned.Timestamp)
			}
		}
	}
}

func (s *Sidecar) readAudioRTP() {
	buf := make([]byte, 1500)
	pkt := &rtp.Packet{}
	count := 0

	for s.running {
		n, err := s.audioConn.Read(buf)
		arrived := time.Now()
		if err != nil {
			if s.running {
				log.Printf("[RTP] Audio read error: %v", err)
			}
			return
		}

		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}

		atomic.AddUint64(&s.audioPktCount, 1)
		atomic.AddUint64(&s.audioOctetCount, uint64(len(pkt.Payload)))

		count++
		if count <= 3 || count%1000 == 0 {
			debugf("[AUDIO] #%d ts=%d (%.3fs)", count, pkt.Timestamp, float64(pkt.Timestamp)/48000.0)
		}

		cloned := cloneRTPPacket(pkt)
		if cloned == nil {
			continue
		}

		s.continueRTP("audio", cloned, "", arrived)
		q := queuedPacket{pkt: cloned, arrived: arrived, clock: s.recordFrame("audio", cloned.Timestamp, arrived)}
		select {
		case s.audioQueue <- q:
		default:
			atomic.AddUint64(&s.rtpAudioDrops, 1)
			if count%200 == 0 {
				log.Printf("[AUDIO] queue full, dropping packet ts=%d", cloned.Timestamp)
			}
		}
	}
}

// processVideoRTP and processAudioRTP forward each packet once sendTime says
// it is due, which holds the earlier track back to meet the later one.
func (s *Sidecar) processVideoRTP() {
	for q := range s.videoQueue {
		s.waitToSend("video", q)
		s.forwardVideoRTP(q.pkt)
	}
}

// forwardVideoRTP writes one video packet to every viewer whose stream gate is
// open, and opens the gate of a waiting viewer when pkt starts a keyframe.
func (s *Sidecar) forwardVideoRTP(pkt *rtp.Packet) {
	codec := s.currentCodec()
	if codec == codecH264 {
		s.h264Params.observe(pkt.Payload)
	}

	s.peersLock.RLock()
	defer s.peersLock.RUnlock()
	for _, peer := range s.peers {
		peer.mu.Lock()
		// A peer negotiated for another codec cannot decode this stream.
		active := peer.Active && peer.Codec == codec
		started := peer.Started
		track := peer.VideoTrack
		opening := false

		if active && !started && isKeyframeStart(codec, pkt.Payload) && peer.canSendMedia() {
			peer.Started = true
			started = true
			opening = true
			log.Printf("[Peer %s] First %s keyframe seen at ts=%d - opening stream gate", peer.ID, codec, pkt.Timestamp)
		}

		peer.mu.Unlock()

		if active && started && track != nil {
			var batch []*rtp.Packet
			if opening && codec == codecH264 {
				prefix := s.h264Params.prefixBefore(pkt)
				batch = append(batch, prefix...)
				debugf("[Peer %s] h264 gate open: %s", peer.ID, h264GateOpenInfo(pkt.Payload, len(prefix)))
			}
			batch = append(batch, pkt)
			for _, p := range batch {
				peer.mu.Lock()
				out := peer.nextVideoRTP(p, opening)
				peer.mu.Unlock()
				if out != nil {
					_ = track.WriteRTP(out)
				}
			}
		}
	}
}

// canSendMedia reports whether packets written to the peer's tracks are sent.
// ICE connects first and the DTLS handshake follows; until that is done Pion
// has no SRTP session and drops what is written without an error. A gate
// opened in between would spend the viewer's keyframe, and any SPS/PPS put in
// front of it, on nothing.
func (p *Peer) canSendMedia() bool {
	return p.PC != nil && p.PC.ConnectionState() == webrtc.PeerConnectionStateConnected
}

// nextVideoRTP clones pkt with this peer's sequence number. Caller holds p.mu.
// The first packet keeps its sequence. follow numbers a packet straight after
// the last one written: it is set for the packets that open the gate (injected
// H.264 parameter sets and the keyframe), so that neither the injected packets
// nor what the peer missed while its gate was closed show as a loss or a
// replay. Every other packet keeps its distance from the one before it, so a
// packet lost on the way to the sidecar stays a gap the viewer can see.
func (p *Peer) nextVideoRTP(pkt *rtp.Packet, follow bool) *rtp.Packet {
	out := cloneRTPPacket(pkt)
	if out == nil {
		return nil
	}
	switch {
	case !p.videoOutSeqOK:
		p.videoOutSeq = pkt.SequenceNumber
		p.videoOutSeqOK = true
	case follow:
		p.videoOutSeq++
	default:
		p.videoOutSeq += pkt.SequenceNumber - p.videoInSeq
	}
	p.videoInSeq = pkt.SequenceNumber
	out.SequenceNumber = p.videoOutSeq
	return out
}

func (s *Sidecar) processAudioRTP() {
	for q := range s.audioQueue {
		s.waitToSend("audio", q)
		pkt := q.pkt
		s.peersLock.RLock()
		for _, peer := range s.peers {
			peer.mu.Lock()
			active := peer.Active
			started := peer.Started
			track := peer.AudioTrack
			peer.mu.Unlock()

			if active && started && track != nil {
				_ = track.WriteRTP(pkt)
			}
		}
		s.peersLock.RUnlock()
	}
}

// CreatePeer builds the WebRTC peer for one viewer and returns its SDP offer.
//
// The offer is returned only once ICE gathering has completed, so it already
// carries every local candidate and none has to be trickled to the viewer
// afterwards. That also makes the slowest STUN server the time a viewer waits
// to join, which is what stunGatherTimeout bounds.
func (s *Sidecar) CreatePeer(id string, codec string) (sdp string, err error) {
	return s.CreatePeerFor(id, codec, false)
}

// CreatePeerFor is CreatePeer for a given kind of viewer. A browser viewer
// (the web UI preview) is also offered browserVideoFallbacks, because a
// browser does not accept every codec variant the TeamSpeak client needs.
func (s *Sidecar) CreatePeerFor(id string, codec string, browser bool) (sdp string, err error) {
	if codec == "" {
		codec = s.currentCodec()
	}
	if !validCodec(codec) {
		return "", fmt.Errorf("unsupported codec %q", codec)
	}

	s.peersLock.Lock()

	// If a create for this ID is already in progress, wait for it FIRST.
	if inflight, exists := s.creating[id]; exists {
		s.peersLock.Unlock()
		debugf("[API] Waiting for in-flight peer creation: %s", id)
		<-inflight.done
		return inflight.sdp, inflight.err
	}

	// Reuse existing peer/offer only when no create is currently in flight.
	if existing, exists := s.peers[id]; exists {
		state := existing.PC.ICEConnectionState()
		if existing.Codec == codec && existing.Browser == browser &&
			state != webrtc.ICEConnectionStateClosed &&
			state != webrtc.ICEConnectionStateFailed &&
			state != webrtc.ICEConnectionStateDisconnected {
			if ld := existing.PC.LocalDescription(); ld != nil {
				s.peersLock.Unlock()
				debugf("[API] Reusing existing peer offer: %s", id)
				return ld.SDP, nil
			}
		}
	}

	inflight := &createInFlight{done: make(chan struct{})}
	s.creating[id] = inflight
	s.peersLock.Unlock()

	log.Printf("[API] Creating NEW peer: %s", id)

	defer func() {
		s.peersLock.Lock()
		inflight.sdp = sdp
		inflight.err = err
		delete(s.creating, id)
		close(inflight.done)
		s.peersLock.Unlock()
	}()

	iceServers := []webrtc.ICEServer{}

	for _, stun := range getStunServers() {
		iceServers = append(iceServers, webrtc.ICEServer{URLs: []string{stun}})
	}

	videoCapability := codecCapability(codec)
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: videoCapability,
		PayloadType:        96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return "", err
	}
	if browser {
		// The track keeps videoCapability; when the browser accepts only a
		// fallback, Pion binds the track to it by codec type and rewrites the
		// payload type on the way out.
		for _, fallback := range browserVideoFallbacks(codec) {
			if err := m.RegisterCodec(fallback, webrtc.RTPCodecTypeVideo); err != nil {
				return "", err
			}
		}
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: 48000,
			Channels:  2,
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return "", err
	}

	i := &interceptor.Registry{}
	intervalPliFactory, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		return "", err
	}
	i.Add(intervalPliFactory)
	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		return "", err
	}

	se := webrtc.SettingEngine{}
	se.SetSTUNGatherTimeout(stunGatherTimeout)
	if err := s.applyICESettings(&se); err != nil {
		return "", fmt.Errorf("ICE settings: %w", err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(i), webrtc.WithSettingEngine(se))

	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: iceServers,
	})
	if err != nil {
		return "", fmt.Errorf("create PeerConnection: %w", err)
	}

	videoTrack, err := webrtc.NewTrackLocalStaticRTP(videoCapability, "video", "ts6-stream")
	if err != nil {
		pc.Close()
		return "", err
	}

	audioTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "ts6-stream",
	)
	if err != nil {
		pc.Close()
		return "", err
	}

	if _, err = pc.AddTrack(videoTrack); err != nil {
		pc.Close()
		return "", err
	}
	if _, err = pc.AddTrack(audioTrack); err != nil {
		pc.Close()
		return "", err
	}

	peer := &Peer{
		ID:         id,
		Codec:      codec,
		Browser:    browser,
		PC:         pc,
		VideoTrack: videoTrack,
		AudioTrack: audioTrack,
		Active:     false,
		stopSR:     make(chan struct{}),
	}

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("[Peer %s] ICE: %s", id, state.String())
		switch state {
		case webrtc.ICEConnectionStateChecking:
			peer.mu.Lock()
			peer.checking = true
			peer.mu.Unlock()
		case webrtc.ICEConnectionStateConnected:
			peer.mu.Lock()
			peer.Active = true
			peer.Started = false
			peer.connected = true
			peer.mu.Unlock()
			// Resolve SSRCs NOW — they are only valid after negotiation
			for _, sender := range pc.GetSenders() {
				params := sender.GetParameters()
				if len(params.Encodings) > 0 {
					ssrc := uint32(params.Encodings[0].SSRC)
					if sender.Track() == videoTrack {
						peer.VideoSSRC = ssrc
						log.Printf("[Peer %s] Video SSRC resolved: %d", id, ssrc)
					} else if sender.Track() == audioTrack {
						peer.AudioSSRC = ssrc
						log.Printf("[Peer %s] Audio SSRC resolved: %d", id, ssrc)
					}
				}
			}
		case webrtc.ICEConnectionStateDisconnected, webrtc.ICEConnectionStateFailed, webrtc.ICEConnectionStateClosed:
			peer.mu.Lock()
			peer.Active = false
			peer.Started = false
			neverConnected := peer.checking && !peer.connected && state != webrtc.ICEConnectionStateDisconnected
			if neverConnected {
				peer.checking = false // Failed is followed by Closed; report once
			}
			offerSDP := peer.offerSDP
			peer.mu.Unlock()
			// A TeamSpeak viewer that cannot reach any offered address shows
			// "Connecting..." and asks to reconnect, which closes this peer.
			// The browser preview reports its own ICE timeout.
			if neverConnected && !browser {
				log.Printf("[Peer %s] TeamSpeak viewer never connected: none of the offered addresses worked for it (%s)", id, offeredAddresses(offerSDP))
				if advertisesOnlyLoopback(s.iceAdvertiseIPs) {
					log.Printf("[Peer %s] %s", id, teamSpeakReachHint)
				}
			}
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("set local desc: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	<-gatherComplete
	peer.mu.Lock()
	peer.offerSDP = pc.LocalDescription().SDP
	peer.mu.Unlock()

	s.peersLock.Lock()
	if old, exists := s.peers[id]; exists {
		old.Active = false
		close(old.stopSR)
		old.PC.Close()
	}
	s.peers[id] = peer
	s.peersLock.Unlock()

	sdp = pc.LocalDescription().SDP
	return sdp, nil
}

// sendSenderReports periodically sends RTCP Sender Reports with synchronized
// NTP timestamps for both audio and video, enabling the browser to correlate
// the two RTP clocks and maintain lip-sync.
func (s *Sidecar) sendSenderReports(peer *Peer) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	cname := "ts6-stream"
	srCount := 0

	for {
		select {
		case <-peer.stopSR:
			return
		case <-ticker.C:
			if !peer.Active {
				continue
			}

			now := time.Now()
			ntpNow := toNTPTime(now)

			videoTs, videoOK := s.senderReportRTPTime("video", now)
			audioTs, audioOK := s.senderReportRTPTime("audio", now)
			vidPkts := uint32(atomic.LoadUint64(&s.videoPktCount))
			vidOctets := uint32(atomic.LoadUint64(&s.videOctetCount))
			audPkts := uint32(atomic.LoadUint64(&s.audioPktCount))
			audOctets := uint32(atomic.LoadUint64(&s.audioOctetCount))

			if !videoOK && !audioOK {
				continue
			}

			srCount++

			// Send video SR + SDES
			if peer.VideoSSRC != 0 && videoOK {
				err := peer.PC.WriteRTCP([]rtcp.Packet{
					&rtcp.SenderReport{
						SSRC:        peer.VideoSSRC,
						NTPTime:     ntpNow,
						RTPTime:     videoTs,
						PacketCount: vidPkts,
						OctetCount:  vidOctets,
					},
					&rtcp.SourceDescription{
						Chunks: []rtcp.SourceDescriptionChunk{{
							Source: peer.VideoSSRC,
							Items: []rtcp.SourceDescriptionItem{{
								Type: rtcp.SDESCNAME,
								Text: cname,
							}},
						}},
					},
				})
				if srCount <= 5 || srCount%30 == 0 {
					log.Printf("[SR] Peer %s video SR #%d ssrc=%d rtpTs=%d err=%v", peer.ID, srCount, peer.VideoSSRC, videoTs, err)
				}
			} else if peer.VideoSSRC == 0 && srCount <= 5 {
				log.Printf("[SR] Peer %s video SSRC still 0 — skipping SR", peer.ID)
			}

			// Send audio SR + SDES with SAME NTP time and SAME CNAME
			if peer.AudioSSRC != 0 && audioOK {
				err := peer.PC.WriteRTCP([]rtcp.Packet{
					&rtcp.SenderReport{
						SSRC:        peer.AudioSSRC,
						NTPTime:     ntpNow,
						RTPTime:     audioTs,
						PacketCount: audPkts,
						OctetCount:  audOctets,
					},
					&rtcp.SourceDescription{
						Chunks: []rtcp.SourceDescriptionChunk{{
							Source: peer.AudioSSRC,
							Items: []rtcp.SourceDescriptionItem{{
								Type: rtcp.SDESCNAME,
								Text: cname,
							}},
						}},
					},
				})
				if srCount <= 5 || srCount%30 == 0 {
					log.Printf("[SR] Peer %s audio SR #%d ssrc=%d rtpTs=%d err=%v", peer.ID, srCount, peer.AudioSSRC, audioTs, err)
				}
			} else if peer.AudioSSRC == 0 && srCount <= 5 {
				log.Printf("[SR] Peer %s audio SSRC still 0 — skipping SR", peer.ID)
			}
		}
	}
}

func (s *Sidecar) SetAnswer(id, sdp string) error {
	s.peersLock.RLock()
	peer, exists := s.peers[id]
	s.peersLock.RUnlock()
	if !exists {
		return fmt.Errorf("peer %s not found", id)
	}

	peer.mu.Lock()
	defer peer.mu.Unlock()

	if peer.PC.RemoteDescription() != nil {
		if peer.PC.RemoteDescription().Type == webrtc.SDPTypeAnswer &&
			peer.PC.SignalingState() == webrtc.SignalingStateStable {
			log.Printf("[API] Ignoring duplicate answer for peer: %s", id)
			return nil
		}
	}

	if peer.PC.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
		log.Printf("[API] Ignoring answer in signaling state %s for peer: %s", peer.PC.SignalingState(), id)
		return nil
	}

	if err := peer.PC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}); err != nil {
		return err
	}

	pending := peer.pendingICE
	peer.pendingICE = nil
	for _, c := range pending {
		if err := peer.PC.AddICECandidate(c); err != nil {
			log.Printf("[API] Dropping early ICE candidate for peer %s: %s", id, quoteErr(err))
		}
	}
	if len(pending) > 0 {
		debugf("[API] Applied %d early ICE candidate(s) for peer: %s", len(pending), id)
	}
	return nil
}

// AddICECandidate applies a remote candidate. Viewers trickle candidates as
// soon as they have the offer, often before their answer reaches us; Pion
// rejects those until the remote description is set, so they are held and
// applied by SetAnswer. They are usually the host candidates, which give the
// most direct path.
func (s *Sidecar) AddICECandidate(id string, candidate string, sdpMid string, sdpMLineIndex uint16) error {
	s.peersLock.RLock()
	peer, exists := s.peers[id]
	s.peersLock.RUnlock()
	if !exists {
		return fmt.Errorf("peer %s not found", id)
	}

	init := webrtc.ICECandidateInit{
		Candidate:     candidate,
		SDPMid:        &sdpMid,
		SDPMLineIndex: &sdpMLineIndex,
	}

	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.PC.RemoteDescription() == nil {
		if len(peer.pendingICE) >= maxPendingICE {
			debugf("[API] Early ICE candidate buffer full for peer %s; dropping candidate", id)
			return nil
		}
		peer.pendingICE = append(peer.pendingICE, init)
		return nil
	}
	return peer.PC.AddICECandidate(init)
}

func (s *Sidecar) ClosePeer(id string) {
	s.peersLock.Lock()
	if peer, exists := s.peers[id]; exists {
		peer.Active = false
		close(peer.stopSR)
		peer.PC.Close()
		delete(s.peers, id)
	}
	s.peersLock.Unlock()
}

// SourceRequest is one POST /source call.
type SourceRequest struct {
	Source string
	// AudioSource is a second remote input carrying the audio, for a source
	// that delivers video and audio separately (YouTube above 720p). Empty
	// means the audio is in Source.
	AudioSource string
	Width       int
	Height      int
	Framerate   int
	Bitrate     string
	Volume      int
	Loop        bool
	Encoder     string
	// Mode is live, vod or file ("" = infer from the source).
	Mode string
	// AllowedHosts are the LAN hosts an admin allowed for this source (IPTV
	// only); ffmpeg may reach no other private address.
	AllowedHosts []string
	// CpuUsed overrides VIDEO_CPU_USED / VIDEO_VP9_CPU_USED when > 0.
	CpuUsed int
	// SilentAudio adds a silent input in place of the source's audio. Set by
	// the sidecar itself when the source turns out to have none
	// (restartWithSilenceIfNoAudio), never by a request.
	SilentAudio bool
}

// EncoderSession reports which encoder is actually running, so a hardware
// fallback is visible instead of silent.
type EncoderSession struct {
	Requested      string     `json:"requested"`
	Active         string     `json:"active"`
	Codec          string     `json:"codec"`
	Hardware       bool       `json:"hardware"`
	FallbackReason string     `json:"fallbackReason,omitempty"`
	State          string     `json:"state"`
	ExitError      string     `json:"exitError,omitempty"`
	StartedAt      *time.Time `json:"startedAt,omitempty"`
	gen            uint64
}

// streamHealth reports encode speed and drops for the current run (nil when idle).
func (s *Sidecar) streamHealth() *StreamHealth {
	s.statusMu.Lock()
	h := s.health
	running := s.encoder.State == "running"
	s.statusMu.Unlock()
	if h == nil || !running {
		return nil
	}
	snap := h.snapshot(atomic.LoadUint64(&s.rtpVideoDrops), atomic.LoadUint64(&s.rtpAudioDrops))
	return &snap
}

func (s *Sidecar) encoderSession() EncoderSession {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	return s.encoder
}

// tailBuffer keeps the last few KB of ffmpeg stderr for exit/fallback reasons.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 4096 {
		t.buf = t.buf[len(t.buf)-4096:]
	}
	return len(p), nil
}

// contains reports whether the end of ffmpeg's stderr contains text.
func (t *tailBuffer) contains(text string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.Contains(string(t.buf), text)
}

// noAudioTrack reports whether ffmpeg stopped because the audio output had
// nothing to take: the source has no audio track. The audio output may only
// take audio (-vn), so ffmpeg 5.1 then exits with this error. The audio
// output is always #1: the video output comes first.
func noAudioTrack(t *tailBuffer) bool {
	return t.contains("Output file #1 does not contain any stream")
}

// silentAudioInput stands in for the audio of a source that has none, so the
// audio RTP output always has something to send. Read at the source's pace
// (-re), or it would be generated as fast as ffmpeg can.
var silentAudioInput = []string{"-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"}

// summary summarizes the end of ffmpeg's stderr for a status reason: the
// last two lines (the final one is often a generic wrapper), URLs redacted.
func (t *tailBuffer) summary() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return summarizeFFmpegError(string(t.buf))
}

var urlPattern = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://\S+`)

func summarizeFFmpegError(out string) string {
	lines := []string{}
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r", "\n"), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > 2 {
		lines = lines[len(lines)-2:]
	}
	summary := urlPattern.ReplaceAllString(strings.Join(lines, "; "), "<source>")
	if len(summary) > 240 {
		summary = summary[:240]
	}
	return summary
}

// hwVerifyWindow is how long a hardware encoder must survive before the
// sidecar trusts it; VAAPI init/encode failures exit well inside this.
func hwVerifyWindow() time.Duration {
	return time.Duration(envIntOrDefault("VAAPI_VERIFY_MS", 1500)) * time.Millisecond
}

// rtpPacketSize caps the video RTP packets FFmpeg sends. A packet must still
// fit one 1500-byte Ethernet frame after the sidecar has added SRTP's auth tag
// and the IP and UDP headers; 1200 is the size WebRTC senders use.
const rtpPacketSize = 1200

// buildFFmpegArgs assembles the full ffmpeg command line for req and spec.
func (s *Sidecar) buildFFmpegArgs(req SourceRequest, spec EncoderSpec, lowPower bool) []string {
	w := req.Width
	h := req.Height
	fps := req.Framerate

	if w <= 0 {
		w = envIntOrDefault("VIDEO_WIDTH", 1280)
	}
	if h <= 0 {
		h = envIntOrDefault("VIDEO_HEIGHT", 720)
	}
	if fps <= 0 {
		fps = envIntOrDefault("VIDEO_FRAMERATE", 30)
	}

	// Periodic progress lines feed the encode-health tracker. -stats keeps
	// them at warning level, which drops per-segment info chatter such as
	// HLS "Skip ('#EXT-X-PROGRAM-DATE-TIME...')" lines from IPTV sources.
	args := []string{"-stats_period", "2", "-stats", "-loglevel", "warning"}
	extraOut := extraFFmpegOutputArgs()
	args = append(args, hwInitArgs(spec, req.Source != "")...)

	source := req.Source
	mode := ""
	// The audio is read from input 0 unless it comes as a second input.
	audioMap := "0:a:0?"
	if source != "" {
		mode = resolveSourceMode(req.Mode, source)
		// Input options apply to the next -i only, so each input gets its own:
		// the proxy, reconnecting and the read pacing. The audio of a split
		// source is a second connection, which is checked and reconnected like
		// the first. The hardware decoder set up by hwInitArgs above stays on
		// the first input, the video.
		inputs := []string{source}
		if req.AudioSource != "" {
			inputs = append(inputs, req.AudioSource)
			audioMap = "1:a:0"
		}
		extraIn := remoteFFmpegInputArgs()
		for _, input := range inputs {
			if isRemoteSource(input) {
				if s.egress != nil {
					args = append(args, egressInputArgs(s.egress.URL())...)
				}
				args = append(args, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
				args = append(args, extraIn...)
			} else if req.Loop && mode == modeFile {
				args = append(args, "-stream_loop", "-1")
			}

			// Live IPTV often has non-monotonic DTS. Without igndts, ffmpeg drops
			// those audio frames and the stream cuts in and out.
			fflags := "+genpts+discardcorrupt"
			if mode == modeLive {
				fflags = "+genpts+igndts+discardcorrupt"
			}
			args = append(args, "-fflags", fflags)
			if mode != modeLive || !livePacedBySource() {
				args = append(args, "-re")
			}
			args = append(args, "-i", input)
		}
		if req.SilentAudio {
			args = append(args, silentAudioInput...)
			audioMap = fmt.Sprintf("%d:a:0", len(inputs))
		}
	} else {
		args = append(args, "-re", "-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=1", w, h))
	}

	vBitrate := strings.TrimSpace(req.Bitrate)
	if vBitrate == "" {
		vBitrate = envOrDefault("VIDEO_BITRATE", "1500k")
	}
	audioDelayMs := envIntOrDefault("AUDIO_DELAY_MS", 0)

	if source != "" {
		vf := fmt.Sprintf(
			"fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,%s",
			fps, w, h, w, h, uploadFilter(spec),
		)
		if framesStayOnGPU(spec, true) {
			vf = gpuVideoFilter(fps, w, h)
			log.Printf("[FFmpeg] Frames stay on the GPU: vaapi decode, scale_vaapi, %s", spec.FFmpeg)
		}
		args = append(args,
			"-map", "0:v:0",
			"-vf", vf,
		)
	} else if spec.Hardware {
		args = append(args, "-vf", uploadFilter(spec))
	}
	args = append(args, encoderArgs(spec, vBitrate, lowPower, req.CpuUsed)...)
	args = append(args,
		"-payload_type", "96",
		"-ssrc", "11111111",
	)
	args = append(args, extraOut...)
	args = append(args,
		"-f", "rtp",
		// FFmpeg's default is 1472 bytes. SRTP adds its auth tag on top, which
		// puts the packet over a 1500-byte MTU: it is fragmented, and one lost
		// fragment loses the packet. 1200 leaves room for SRTP and tunnels.
		"-pkt_size", fmt.Sprintf("%d", rtpPacketSize),
		fmt.Sprintf("rtp://127.0.0.1:%d", s.videoPort),
	)

	if source != "" {
		aBitrate := envOrDefault("AUDIO_BITRATE", "128k")

		args = append(args,
			"-map", audioMap,
			// Audio only. Without this, a source with no audio track left
			// the optional map above matching nothing, and ffmpeg picked a
			// stream for this output itself: the video, encoded a second time
			// (as MPEG-4) into the audio RTP port. Now ffmpeg stops at once
			// instead, and the stream starts again with silence.
			"-vn", "-sn", "-dn",
		)

		audioFilters := []string{}
		if audioDelayMs > 0 {
			audioFilters = append(audioFilters, fmt.Sprintf("adelay=delays=%d:all=1", audioDelayMs))
		}
		// Live sources (IPTV) routinely deliver AAC whose timestamps jump at
		// segment or PCR boundaries. async resample stretches or pads to keep
		// a continuous 48 kHz timeline so Opus RTP does not stall playout.
		// async is samples per second of correction, not a boolean.
		if mode == modeLive {
			audioFilters = append(audioFilters, "aresample=async=1000:first_pts=0")
		}
		if req.Volume >= 0 && req.Volume <= 100 && req.Volume != 100 {
			audioFilters = append(audioFilters, fmt.Sprintf("volume=%.2f", float64(req.Volume)/100.0))
		}
		if len(audioFilters) > 0 {
			args = append(args, "-af", strings.Join(audioFilters, ","))
		}

		args = append(args,
			"-c:a", "libopus",
			"-b:a", aBitrate,
			"-ar", "48000",
			"-ac", "2",
			"-payload_type", "111",
			"-ssrc", "22222222",
		)
		args = append(args, extraOut...)
		args = append(args,
			"-f", "rtp",
			fmt.Sprintf("rtp://127.0.0.1:%d", s.audioPort),
		)
	}
	return args
}

// launchFFmpegLocked starts ffmpeg and returns a channel closed on exit.
func (s *Sidecar) launchFFmpegLocked(args []string, gen uint64, health *healthTracker) (<-chan struct{}, *tailBuffer, error) {
	tail := &tailBuffer{}
	cmd := exec.Command(getFfmpegPath(), args...)
	if s.egress != nil {
		cmd.Env = egressCommandEnv()
	}
	cmd.Stdout = nil
	cmd.Stderr = io.MultiWriter(os.Stderr, tail, health)
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	s.ffmpeg = cmd

	done := make(chan struct{})
	go func() {
		err := cmd.Wait()
		log.Printf("[FFmpeg] Exited: %v", err)
		s.statusMu.Lock()
		if s.encoder.gen == gen && atomic.LoadUint64(&s.ffmpegGen) == gen {
			s.encoder.State = "exited"
			if err != nil {
				reason := tail.summary()
				if reason == "" {
					reason = err.Error()
				}
				s.encoder.ExitError = reason
			}
		}
		s.statusMu.Unlock()
		close(done)
	}()
	return done, tail, nil
}

// StartFFmpeg (re)starts the encoder for req. A hardware encoder that is known
// unavailable, or that exits inside hwVerifyWindow, is replaced by the
// software encoder of the same codec and the reason is reported.
func (s *Sidecar) StartFFmpeg(req SourceRequest) (EncoderSession, error) {
	s.ffmpegLock.Lock()
	defer s.ffmpegLock.Unlock()
	return s.startFFmpegLocked(req)
}

func (s *Sidecar) startFFmpegLocked(req SourceRequest) (EncoderSession, error) {
	var err error
	req.Source, err = resolveSource(req.Source)
	if err != nil {
		return EncoderSession{}, err
	}
	if err := validAudioSource(req.Source, req.AudioSource); err != nil {
		log.Printf("[FFmpeg] Rejected source: %v", err)
		return EncoderSession{}, err
	}
	requested, ok := lookupEncoder(req.Encoder)
	if !ok {
		return EncoderSession{}, fmt.Errorf("unknown encoder %q", req.Encoder)
	}

	s.StopFFmpegLocked()
	s.resetSyncTiming()
	s.drainRTPQueues()
	s.resetPeerStreamState()

	// One proxy per source, kept across the hardware-fallback relaunches below.
	if isRemoteSource(req.Source) && egressEnabled() {
		proxy, err := startEgressProxy(&egressPolicy{allow: parseHostAllowlist(req.AllowedHosts)})
		if err != nil {
			return EncoderSession{}, fmt.Errorf("start egress proxy: %w", err)
		}
		s.egress = proxy
	}

	s.source = req.Source
	s.streamCodec.Store(requested.Codec)

	spec := requested
	fallbackReason := ""
	lowPower := os.Getenv("VAAPI_LOW_POWER") == "1"
	// When the capability cache already probed this encoder, lowPower is known.
	// Otherwise allow one flip of lowPower before software fallback (matches probeOneEncoder).
	probe, capsKnown := s.caps.peek().find(spec.ID)
	// Only VAAPI has a low-power mode to flip.
	triedLowPowerToggle := spec.Backend != backendVAAPI || capsKnown
	if spec.Hardware {
		if capsKnown {
			if !probe.Available {
				fallbackReason = probe.Error
				if fallbackReason == "" {
					fallbackReason = "hardware encoder unavailable"
				}
				spec = softwareEncoderFor(spec.Codec)
			} else {
				lowPower = probe.LowPower
			}
		} else if spec.Backend == backendVAAPI && !vaapiDevicePresent() {
			fallbackReason = "VAAPI device not present"
			spec = softwareEncoderFor(spec.Codec)
		}
	}

	for {
		gen := atomic.AddUint64(&s.ffmpegGen, 1)
		now := time.Now().UTC()
		s.statusMu.Lock()
		s.encoder = EncoderSession{
			Requested:      requested.ID,
			Active:         spec.ID,
			Codec:          spec.Codec,
			Hardware:       spec.Hardware,
			FallbackReason: fallbackReason,
			State:          "running",
			StartedAt:      &now,
			gen:            gen,
		}
		s.statusMu.Unlock()

		args := s.buildFFmpegArgs(req, spec, lowPower)
		mode := resolveSourceMode(req.Mode, req.Source)
		health := newHealthTracker(mode, nil)
		atomic.StoreUint64(&s.rtpVideoDrops, 0)
		atomic.StoreUint64(&s.rtpAudioDrops, 0)
		s.statusMu.Lock()
		s.health = health
		s.statusMu.Unlock()
		log.Printf("[FFmpeg] Starting: encoder=%s mode=%s video=:%d audio=:%d", spec.ID, mode, s.videoPort, s.audioPort)
		done, tail, err := s.launchFFmpegLocked(args, gen, health)
		if err != nil {
			log.Printf("[FFmpeg] Start error: %v", err)
			s.statusMu.Lock()
			s.encoder.State = "exited"
			s.encoder.ExitError = err.Error()
			s.statusMu.Unlock()
			return s.encoderSession(), fmt.Errorf("start ffmpeg: %w", err)
		}

		if req.Source != "" && !req.SilentAudio {
			go s.restartWithSilenceIfNoAudio(req, gen, done, tail)
		}

		if !spec.Hardware {
			return s.encoderSession(), nil
		}

		select {
		case <-done:
			if req.Source != "" && !req.SilentAudio && noAudioTrack(tail) {
				// Not the hardware encoder's fault: start it again with
				// silence for the missing audio track.
				s.ffmpeg = nil
				log.Printf("[FFmpeg] The source has no audio track; starting again with silence")
				req.SilentAudio = true
				continue
			}
			reason := tail.summary()
			if reason == "" {
				reason = "hardware encoder exited during startup"
			}
			s.ffmpeg = nil
			if !triedLowPowerToggle {
				triedLowPowerToggle = true
				lowPower = !lowPower
				log.Printf("[FFmpeg] %s failed (%s); retrying with low_power=%v", spec.ID, reason, lowPower)
				continue
			}
			log.Printf("[FFmpeg] %s failed (%s); falling back to software", spec.ID, reason)
			fallbackReason = reason
			spec = softwareEncoderFor(spec.Codec)
			continue
		case <-time.After(hwVerifyWindow()):
			return s.encoderSession(), nil
		}
	}
}

// restartWithSilenceIfNoAudio starts the stream again with a silent audio
// input when the ffmpeg of generation gen stopped because the source has no
// audio track. Only if nothing has moved on since: a stop, a new source and
// the hardware check in startFFmpegLocked all start a new generation. That
// check holds ffmpegLock until it returns, so this waits for it and then
// sees its generation.
func (s *Sidecar) restartWithSilenceIfNoAudio(req SourceRequest, gen uint64, done <-chan struct{}, tail *tailBuffer) {
	<-done
	if !noAudioTrack(tail) {
		return
	}
	s.ffmpegLock.Lock()
	defer s.ffmpegLock.Unlock()
	if atomic.LoadUint64(&s.ffmpegGen) != gen {
		return
	}
	log.Printf("[FFmpeg] The source has no audio track; starting again with silence")
	req.SilentAudio = true
	if _, err := s.startFFmpegLocked(req); err != nil {
		log.Printf("[FFmpeg] Restart with silence failed: %v", err)
	}
}

func (s *Sidecar) StopFFmpegLocked() {
	atomic.AddUint64(&s.ffmpegGen, 1)
	if s.ffmpeg != nil && s.ffmpeg.Process != nil {
		s.ffmpeg.Process.Kill()
		s.ffmpeg = nil
	}
	if s.egress != nil {
		s.egress.Close()
		s.egress = nil
	}
	s.statusMu.Lock()
	if s.encoder.State == "running" {
		s.encoder.State = "stopped"
	}
	s.statusMu.Unlock()
}

func (s *Sidecar) GetStats() map[string]interface{} {
	s.peersLock.RLock()
	defer s.peersLock.RUnlock()

	peers := map[string]interface{}{}
	for id, peer := range s.peers {
		peers[id] = map[string]interface{}{
			"active": peer.Active,
			"state":  peer.PC.ICEConnectionState().String(),
		}
	}

	return map[string]interface{}{
		"videoPort": s.videoPort,
		"audioPort": s.audioPort,
		"peerCount": len(s.peers),
		"peers":     peers,
		"source":    s.source,
		"codec":     s.currentCodec(),
		"encoder":   s.encoderSession(),
		"health":    s.streamHealth(),
	}
}

func (s *Sidecar) Stop() {
	s.running = false
	s.ffmpegLock.Lock()
	s.StopFFmpegLocked()
	s.ffmpegLock.Unlock()

	if s.videoConn != nil {
		s.videoConn.Close()
	}
	if s.audioConn != nil {
		s.audioConn.Close()
	}

	s.peersLock.Lock()
	for id, peer := range s.peers {
		peer.Active = false
		peer.PC.Close()
		delete(s.peers, id)
	}
	s.peersLock.Unlock()

	s.stopICEMedia()
}

func (s *Sidecar) postPeerAnswer(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID  string `json:"id"`
		SDP string `json:"sdp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	debugf("[API] Setting answer for peer: %s (%d bytes)", req.ID, len(req.SDP))

	if err := s.SetAnswer(req.ID, req.SDP); err != nil {
		log.Printf("[API] SetAnswer error: %s", quoteErr(err))
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Sidecar) postPeerICE(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID            string `json:"id"`
		Candidate     string `json:"candidate"`
		SDPMid        string `json:"sdpMid"`
		SDPMLineIndex uint16 `json:"sdpMLineIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	if err := s.AddICECandidate(req.ID, req.Candidate, req.SDPMid, req.SDPMLineIndex); err != nil {
		log.Printf("[API] AddICE error: %s", quoteErr(err))
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func requireSidecarAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := os.Getenv("SIDECAR_SECRET")
		if secret == "" {
			http.Error(w, "sidecar auth not configured", http.StatusServiceUnavailable)
			return
		}
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) || subtle.ConstantTimeCompare([]byte(auth[len(prefix):]), []byte(secret)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func main() {
	if printVersionIfRequested(os.Args, os.Stdout) {
		return
	}

	port := 9800
	if p := os.Getenv("SIDECAR_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil {
			port = v
		}
	}

	if os.Getenv("SIDECAR_SECRET") == "" {
		log.Println("[WARN] SIDECAR_SECRET is not set — mutating API endpoints will reject all requests")
	}

	sidecar := NewSidecar()
	if err := sidecar.startICEMedia(); err != nil {
		log.Fatalf("Failed to start ICE media: %v", err)
	}
	if err := sidecar.StartRTP(); err != nil {
		log.Fatalf("Failed to start RTP: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("POST /peer/create", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID    string `json:"id"`
			Codec string `json:"codec"`
			// Browser marks a browser viewer (the web UI preview).
			Browser bool `json:"browser"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		debugf("[API] Peer create requested: %s (codec=%s browser=%v)", req.ID, req.Codec, req.Browser)
		if req.Codec != "" && !validCodec(req.Codec) {
			http.Error(w, "unsupported codec", 400)
			return
		}

		sdp, err := sidecar.CreatePeerFor(req.ID, req.Codec, req.Browser)
		if err != nil {
			log.Printf("[API] CreatePeer error: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"sdp": sdp})
	}))

	mux.HandleFunc("POST /peer/answer", requireSidecarAuth(sidecar.postPeerAnswer))
	mux.HandleFunc("POST /peer/ice", requireSidecarAuth(sidecar.postPeerICE))

	mux.HandleFunc("POST /peer/close", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		sidecar.ClosePeer(req.ID)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))

	mux.HandleFunc("POST /source", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Source string `json:"source"`
			// AudioSource is a second remote URL with the audio, when source
			// is video only.
			AudioSource string `json:"audioSource"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			Framerate   int    `json:"framerate"`
			Bitrate     string `json:"bitrate"`
			Volume      *int   `json:"volume"`
			// Loop defaults to true (prior behavior for local backgrounds) when omitted;
			// the backend sets false for on-demand downloaded clips.
			Loop *bool `json:"loop"`
			// Encoder is a registry ID (vp8, h264_vaapi, ...); empty keeps VP8.
			Encoder string `json:"encoder"`
			// Mode is live, vod or file; empty infers it from the source.
			Mode string `json:"mode"`
			// AllowedHosts are admin-approved LAN hosts (IPTV sources only).
			AllowedHosts []string `json:"allowedHosts"`
			// CpuUsed overrides VIDEO_CPU_USED for software VP8/VP9 when > 0.
			CpuUsed int `json:"cpuUsed"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := validSource(req.Source); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := validAudioSource(req.Source, req.AudioSource); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		vol := 100
		if req.Volume != nil {
			vol = *req.Volume
			if vol < 0 {
				vol = 0
			}
			if vol > 100 {
				vol = 100
			}
		}
		encoderID := req.Encoder
		if encoderID == "" {
			encoderID = "vp8"
		}
		if _, ok := lookupEncoder(encoderID); !ok {
			http.Error(w, "unknown encoder", 400)
			return
		}
		loop := req.Loop == nil || *req.Loop
		log.Printf("[API] Setting source (%dx%d @ %dfps vol=%d loop=%v encoder=%s)", req.Width, req.Height, req.Framerate, vol, loop, encoderID)
		session, err := sidecar.StartFFmpeg(SourceRequest{
			Source:       req.Source,
			AudioSource:  req.AudioSource,
			Width:        req.Width,
			Height:       req.Height,
			Framerate:    req.Framerate,
			Bitrate:      req.Bitrate,
			Volume:       vol,
			Loop:         loop,
			Encoder:      encoderID,
			Mode:         req.Mode,
			AllowedHosts: req.AllowedHosts,
			CpuUsed:      req.CpuUsed,
		})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "encoder": session})
	}))

	// POST /probe reads a remote source's video size and duration for Auto
	// quality, through the same egress policy as streaming it.
	mux.HandleFunc("POST /probe", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Source       string   `json:"source"`
			AllowedHosts []string `json:"allowedHosts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if !isRemoteSource(req.Source) {
			http.Error(w, "only http(s) sources are probed here", 400)
			return
		}
		out, err := probeRemoteSource(r.Context(), req.Source, &egressPolicy{allow: parseHostAllowlist(req.AllowedHosts)})
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	}))

	mux.HandleFunc("POST /source/stop", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		sidecar.ffmpegLock.Lock()
		sidecar.StopFFmpegLocked()
		sidecar.resetSyncTiming()
		sidecar.drainRTPQueues()
		sidecar.resetPeerStreamState()
		sidecar.ffmpegLock.Unlock()

		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))

	// GET /encoders returns cached encoder capabilities; the first call (or
	// ?refresh=1) runs short test encodes, so callers use it on demand only.
	mux.HandleFunc("GET /encoders", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		caps := sidecar.caps.get(r.URL.Query().Get("refresh") == "1")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(caps)
	}))

	mux.HandleFunc("GET /stats", requireSidecarAuth(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(sidecar.GetStats())
	}))

	build := buildInfo()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "ok",
			"videoPort": sidecar.videoPort,
			"audioPort": sidecar.audioPort,
			"version":   build["version"],
			"os":        build["os"],
			"arch":      build["arch"],
		})
	})

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		sidecar.Stop()
		os.Exit(0)
	}()

	addr := httpListenAddr(port)
	log.Printf("[Sidecar] %s (%s/%s) HTTP API listening on %s", build["version"], build["os"], build["arch"], addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}
