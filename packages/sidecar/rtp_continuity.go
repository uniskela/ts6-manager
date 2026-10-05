package main

import (
	"sync"
	"time"

	"github.com/pion/rtp"
)

// rtpContinuity keeps one outgoing track's RTP numbering continuous across
// FFmpeg restarts.
//
// Every FFmpeg run starts its RTP muxer at a random sequence number and a
// random timestamp (and VP8/VP9 picture IDs at zero), while the SSRC stays
// fixed. A viewer that keeps its connection through a source switch sees the
// same stream jump backwards: libwebrtc then drops the new frames as older
// than the last one it decoded, and video stays frozen until the numbers
// catch up, which can take minutes. Audio recovers on its own. Shifting each
// new run so it carries on from where the previous one stopped lets the
// first keyframe of the new source decode at once.
type rtpContinuity struct {
	mu        sync.Mutex
	clockRate uint32

	started bool
	// restarted is set when FFmpeg is restarted; the next packet rebases.
	restarted bool

	seqOffset uint16
	tsOffset  uint32
	lastInSeq uint16
	lastSeq   uint16 // output
	lastTS    uint32 // output
	lastAt    time.Time

	// VP8/VP9 picture ID, rebased with the rest. picCodec is the codec the
	// IDs belong to; a codec change starts them afresh.
	picCodec  string
	picOK     bool
	picOffset uint16
	lastPic   uint16 // output, 15-bit
}

// maxContinuousSeqStep bounds a sequence step still treated as the same
// FFmpeg run, so packets an old run left in the socket after a restart do
// not hide the new run's jump.
const (
	maxContinuousSeqStep  = 1000
	maxContinuousSeqBack  = 100
	pictureIDModulus      = 1 << 15
	pictureIDShortModulus = 1 << 7
)

// markRestart makes the next packet carry on from the last one sent.
func (c *rtpContinuity) markRestart() {
	c.mu.Lock()
	c.restarted = true
	c.mu.Unlock()
}

// rewrite shifts pkt's sequence number, timestamp and (for VP8/VP9) picture
// ID in place. now is the packet's arrival time. When pkt starts a new run,
// target gives the timestamp it should carry; nil carries on by the wall
// clock gap since the last packet. Either way the timestamp moves forward.
func (c *rtpContinuity) rewrite(pkt *rtp.Packet, codec string, now time.Time, target func() uint32) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.started {
		c.started = true
		c.restarted = false
	} else {
		step := int16(pkt.SequenceNumber - c.lastInSeq)
		if c.restarted || step > maxContinuousSeqStep || step < -maxContinuousSeqBack {
			c.restarted = false
			c.seqOffset = c.lastSeq + 1 - pkt.SequenceNumber
			var want uint32
			if target != nil {
				want = target()
			} else {
				want = c.lastTS + uint32(uint64(max(now.Sub(c.lastAt), 0))*uint64(c.clockRate)/uint64(time.Second))
			}
			if int32(want-c.lastTS) <= 0 {
				want = c.lastTS + 1
			}
			c.tsOffset = want - pkt.Timestamp
			c.rebasePictureID(pkt, codec)
		}
	}
	c.lastInSeq = pkt.SequenceNumber

	pkt.SequenceNumber += c.seqOffset
	pkt.Timestamp += c.tsOffset
	c.lastSeq = pkt.SequenceNumber
	c.lastTS = pkt.Timestamp
	c.lastAt = now

	if codec != c.picCodec {
		c.picCodec = codec
		c.picOK = false
		c.picOffset = 0
	}
	if pic, ok := c.shiftPictureID(pkt.Payload, codec); ok {
		c.lastPic = pic
		c.picOK = true
	}
}

// rebasePictureID sets picOffset so pkt's picture ID follows the last one
// sent. Caller holds mu.
func (c *rtpContinuity) rebasePictureID(pkt *rtp.Packet, codec string) {
	if !c.picOK || codec != c.picCodec {
		c.picOffset = 0
		return
	}
	pic, _, ok := pictureID(pkt.Payload, codec)
	if !ok {
		return
	}
	c.picOffset = (c.lastPic + 1 - pic) % pictureIDModulus
}

// shiftPictureID applies picOffset to payload's picture ID in place and
// returns the new ID. Caller holds mu.
func (c *rtpContinuity) shiftPictureID(payload []byte, codec string) (uint16, bool) {
	pic, at, ok := pictureID(payload, codec)
	if !ok {
		return 0, false
	}
	if payload[at]&0x80 != 0 {
		out := (pic + c.picOffset) % pictureIDModulus
		payload[at] = 0x80 | byte(out>>8)
		payload[at+1] = byte(out)
		return out, true
	}
	out := (pic + c.picOffset) % pictureIDShortModulus
	payload[at] = byte(out)
	return out, true
}

// pictureID reads the VP8/VP9 RTP payload descriptor's picture ID and the
// offset of its first byte. ok is false when there is none.
func pictureID(payload []byte, codec string) (id uint16, at int, ok bool) {
	switch codec {
	case codecVP8:
		// X bit, then the I bit of the extension byte.
		if len(payload) < 3 || payload[0]&0x80 == 0 || payload[1]&0x80 == 0 {
			return 0, 0, false
		}
		at = 2
	case codecVP9:
		if len(payload) < 2 || payload[0]&0x80 == 0 {
			return 0, 0, false
		}
		at = 1
	default:
		return 0, 0, false
	}
	if payload[at]&0x80 != 0 {
		if len(payload) < at+2 {
			return 0, 0, false
		}
		return uint16(payload[at]&0x7F)<<8 | uint16(payload[at+1]), at, true
	}
	return uint16(payload[at] & 0x7F), at, true
}

// clockLine is a run's mapping of RTP time to the wall clock, as the pacer
// and the Sender Reports use it: base is the timestamp at media time zero,
// which left FFmpeg at wall.
type clockLine struct {
	valid bool
	base  uint32
	wall  time.Time
}

func (l clockLine) at(t time.Time, clockRate uint32) uint32 {
	return l.base + uint32(int64(t.Sub(l.wall))*int64(clockRate)/int64(time.Second))
}

// continueRTP rewrites one packet from FFmpeg (see rtpContinuity) before the
// pacer records it.
//
// A new run's timestamps carry on the previous run's clock line, with both
// tracks anchored at the same wall time, the new run's media time zero. The
// pacer and the Sender Reports assume both tracks start together at that
// instant, so a viewer keeps the audio and video lined up across a switch
// instead of carrying the old mapping over a shifted timeline.
func (s *Sidecar) continueRTP(kind string, pkt *rtp.Packet, codec string, arrived time.Time) {
	s.timingMu.Lock()
	defer s.timingMu.Unlock()

	current, _, clockRate := s.trackTimingsLocked(kind)
	cont, prev := &s.videoRTP, s.prevVideoLine
	if kind == "audio" {
		cont, prev = &s.audioRTP, s.prevAudioLine
	}
	cont.rewrite(pkt, codec, arrived, func() uint32 {
		anchor := arrived
		if s.streamBaseSet {
			anchor = s.streamBaseWall
		}
		switch {
		case current.initialized:
			// Packets of the old run started this one; follow its line.
			return clockLine{base: current.baseRTP, wall: s.streamBaseWall}.at(arrived, clockRate)
		case prev.valid:
			return prev.at(anchor, clockRate)
		}
		return cont.lastTS + uint32(int64(max(arrived.Sub(cont.lastAt), 0))*int64(clockRate)/int64(time.Second))
	})
}
