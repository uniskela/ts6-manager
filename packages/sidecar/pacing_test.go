package main

import (
	"sort"
	"testing"
	"time"
)

// Frame shapes of the stream FFmpeg sends: 30 fps video on a 90 kHz clock,
// 20 ms Opus packets on a 48 kHz clock.
const (
	videoStep    = 3000
	videoPeriod  = time.Second / 30
	audioStep    = 960
	audioPeriod  = 20 * time.Millisecond
	testVideoRTP = 0xFFFFF000 // wraps a few frames in
	testAudioRTP = 123456
)

func newTestPacer() *Sidecar {
	s := NewSidecar()
	s.syncBuffer = 50 * time.Millisecond
	s.videoBias = 0
	s.maxTrackDelay = time.Second
	return s
}

type arrival struct {
	kind    string
	index   int
	ts      uint32
	arrived time.Time
}

// frames lists a track's frames for dur of media, each arriving latency after
// its media time, counted from t0.
func frames(kind string, t0 time.Time, latency, dur time.Duration) []arrival {
	var out []arrival
	base, step, period := uint32(testAudioRTP), uint32(audioStep), audioPeriod
	if kind == "video" {
		base, step, period = testVideoRTP, videoStep, videoPeriod
	}
	for i := 0; time.Duration(i)*period < dur; i++ {
		media := time.Duration(i) * period
		out = append(out, arrival{kind, i, base + uint32(i)*step, t0.Add(media + latency)})
	}
	return out
}

// record feeds arrivals to s in the order they arrive and returns each one's
// clock, by kind and frame number.
func record(s *Sidecar, arrivals ...[]arrival) map[string]map[int]arrivalClock {
	var all []arrival
	for _, a := range arrivals {
		all = append(all, a...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].arrived.Before(all[j].arrived) })
	out := map[string]map[int]arrivalClock{"video": {}, "audio": {}}
	for _, a := range all {
		out[a.kind][a.index] = arrivalClock{a.arrived, s.recordFrame(a.kind, a.ts, a.arrived)}
	}
	return out
}

type arrivalClock struct{ arrived, clock time.Time }

// hold is how long the packet waits if it is sent when sendTime says, asked
// at the moment it arrives.
func hold(s *Sidecar, kind string, ac arrivalClock) time.Duration {
	if ac.arrived.IsZero() {
		panic("hold: no such frame was recorded")
	}
	return s.sendTime(kind, ac.clock, ac.arrived, ac.arrived).Sub(ac.arrived)
}

func near(got, want time.Duration) bool {
	d := got - want
	return d > -2*time.Millisecond && d < 2*time.Millisecond
}

// The skew measured on the sidecar image: video leaves FFmpeg about half a
// second after audio, from the decoder's frame threading. Only the audio
// should wait, by the skew plus the buffer, and the video by the buffer.
func TestPacingHoldsTheEarlierTrackByTheSkew(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	got := record(s, frames("audio", t0, 10*time.Millisecond, 10*time.Second),
		frames("video", t0, 530*time.Millisecond, 10*time.Second))

	if h := hold(s, "audio", got["audio"][400]); !near(h, 570*time.Millisecond) {
		t.Errorf("audio held %v, want 570ms (520ms skew + 50ms buffer)", h)
	}
	if h := hold(s, "video", got["video"][240]); !near(h, 50*time.Millisecond) {
		t.Errorf("video held %v, want the 50ms buffer only", h)
	}
}

// The pacer this replaces measured latency after its own sleep, so its hold
// climbed to the cap within seconds, however well the tracks were already
// aligned. Aligned tracks must be held by the buffer alone, and stay there.
func TestPacingDoesNotGrowOnItsOwnHold(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	got := record(s, frames("audio", t0, 80*time.Millisecond, 20*time.Second),
		frames("video", t0, 80*time.Millisecond, 20*time.Second))

	for _, sec := range []int{2, 10, 19} {
		for kind, perSecond := range map[string]int{"audio": 50, "video": 30} {
			if h := hold(s, kind, got[kind][sec*perSecond]); !near(h, 50*time.Millisecond) {
				t.Errorf("%s at %ds held %v, want 50ms", kind, sec, h)
			}
		}
	}
}

// A break in the source's timestamps (IPTV PCR/PTS breaks) re-bases a track on
// the wall clock. The skew between the tracks is not part of the break: after
// it, the audio must still wait for the video.
func TestPacingKeepsTheSkewAcrossATimestampBreak(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	audio := frames("audio", t0, 10*time.Millisecond, 10*time.Second)
	video := frames("video", t0, 310*time.Millisecond, 10*time.Second)
	// Five seconds in, both tracks jump an hour ahead.
	for i := range audio {
		if i >= 250 {
			audio[i].ts += 3600 * 48000
		}
	}
	for i := range video {
		if i >= 150 {
			video[i].ts += 3600 * 90000
		}
	}
	got := record(s, audio, video)

	for _, at := range []int{250, 300, 450} {
		if h := hold(s, "audio", got["audio"][at]); !near(h, 350*time.Millisecond) {
			t.Errorf("audio frame %d held %v, want 350ms (300ms skew + 50ms buffer)", at, h)
		}
	}
	for _, at := range []int{150, 180, 270} {
		if h := hold(s, "video", got["video"][at]); !near(h, 50*time.Millisecond) {
			t.Errorf("video frame %d held %v, want the 50ms buffer only", at, h)
		}
	}
}

// Audio starts first. Sent alone it would run ahead, then stall when the
// video appears; held, it must go out together with the video's first frame.
func TestPacingHoldsTheFirstTrackUntilTheOtherStarts(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	audio := record(s, frames("audio", t0, 0, 400*time.Millisecond))["audio"]

	first := audio[0]
	if h := hold(s, "audio", first); h != time.Second {
		t.Fatalf("before the video starts, audio held %v, want the 1s maximum", h)
	}

	video := record(s, frames("video", t0, 400*time.Millisecond, videoPeriod))["video"]
	videoStart := video[0].arrived
	audioSend := s.sendTime("audio", first.clock, first.arrived, videoStart)
	videoSend := s.sendTime("video", video[0].clock, video[0].arrived, videoStart)
	if !audioSend.Equal(videoSend) {
		t.Errorf("first audio sent at +%v, first video at +%v; want them together",
			audioSend.Sub(t0), videoSend.Sub(t0))
	}
	if want := t0.Add(450 * time.Millisecond); !videoSend.Equal(want) {
		t.Errorf("first frames sent at +%v, want +450ms (400ms skew + buffer)", videoSend.Sub(t0))
	}
}

// A source without audio must not hold its video for good.
func TestPacingStopsWaitingForAMissingTrack(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	video := record(s, frames("video", t0, 0, 3*time.Second))["video"]

	if h := hold(s, "video", video[0]); h != time.Second {
		t.Errorf("first video frame held %v, want the 1s maximum while audio may still start", h)
	}
	late := video[60] // 2 s in
	if h := hold(s, "video", late); !near(h, 50*time.Millisecond) {
		t.Errorf("video held %v once audio is overdue, want the 50ms buffer", h)
	}
}

// One bad timestamp must neither hold its packet past the cap nor, through
// the latency average, the packets after it.
func TestPacingNeverHoldsPastTheCap(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	record(s, frames("audio", t0, 0, time.Second), frames("video", t0, 0, time.Second))

	arrived := t0.Add(time.Second)
	base := uint32(testVideoRTP)
	bad := s.recordFrame("video", base+90000*3600, arrived) // an hour ahead, wrapping
	if h := s.sendTime("video", bad, arrived, arrived).Sub(arrived); h > s.maxTrackDelay {
		t.Errorf("bad timestamp held %v, over the %v cap", h, s.maxTrackDelay)
	}
}

func TestPacketsOfOneFrameShareItsClock(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	a := s.recordFrame("video", testVideoRTP, t0)
	b := s.recordFrame("video", testVideoRTP, t0.Add(3*time.Millisecond))
	if !a.Equal(b) {
		t.Errorf("second packet of a frame placed at %v, first at %v", b.Sub(t0), a.Sub(t0))
	}
}

// Sender Reports tell the receiver which timestamps of the two tracks belong
// together. They must pair the media time being sent, not the last packet
// read from FFmpeg, which for video is half a second older than for audio.
func TestSenderReportsPairTheTracksByMediaTime(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	record(s, frames("audio", t0, 10*time.Millisecond, 10*time.Second),
		frames("video", t0, 530*time.Millisecond, 10*time.Second))

	now := t0.Add(9 * time.Second)
	vts, vok := s.senderReportRTPTime("video", now)
	ats, aok := s.senderReportRTPTime("audio", now)
	if !vok || !aok {
		t.Fatalf("both tracks have started, got ok video=%v audio=%v", vok, aok)
	}

	videoMedia := time.Duration(vts-testVideoRTP) * time.Second / 90000
	audioMedia := time.Duration(ats-testAudioRTP) * time.Second / 48000
	if !near(videoMedia, audioMedia) {
		t.Errorf("reports pair video %v with audio %v; want the same media time", videoMedia, audioMedia)
	}
	// Audio's first packet (10 ms after t0) is the clock's origin, and both
	// tracks are sent 570 ms behind it.
	if want := 9*time.Second - 10*time.Millisecond - 570*time.Millisecond; !near(audioMedia, want) {
		t.Errorf("reported media time %v, want %v", audioMedia, want)
	}
}

func TestSenderReportsWaitForTheTrackToStart(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	if _, ok := s.senderReportRTPTime("audio", t0); ok {
		t.Error("no report before any packet")
	}
	record(s, frames("audio", t0, 0, time.Second))
	if _, ok := s.senderReportRTPTime("video", t0.Add(time.Second)); ok {
		t.Error("no video report before a video packet")
	}
	if _, ok := s.senderReportRTPTime("audio", t0.Add(time.Second)); !ok {
		t.Error("audio has started and should be reported")
	}
}

// A new source starts a new clock.
func TestResetSyncTimingForgetsTheOldStream(t *testing.T) {
	s := newTestPacer()
	t0 := time.Unix(1_000_000, 0)
	record(s, frames("audio", t0, 0, time.Second), frames("video", t0, 500*time.Millisecond, time.Second))
	s.resetSyncTiming()

	t1 := t0.Add(time.Minute)
	got := record(s, frames("audio", t1, 0, 2*time.Second), frames("video", t1, 0, 2*time.Second))
	if h := hold(s, "audio", got["audio"][75]); !near(h, 50*time.Millisecond) {
		t.Errorf("audio held %v after reset, want 50ms: the old stream's skew leaked", h)
	}
}
