package main

import (
	"fmt"
	"sync"

	"github.com/pion/rtp"
)

// h264NALTypes returns the NAL unit types carried by one H.264 RTP payload
// (single NAL, STAP-A, or the reconstructed type of an FU-A start).
func h264NALTypes(payload []byte) []byte {
	var out []byte
	for _, nal := range h264NALUnits(payload) {
		out = append(out, nal[0]&0x1F)
	}
	return out
}

// h264NALUnits returns each complete NAL unit in payload. FU-A fragments that
// are not the start packet are skipped (incomplete).
func h264NALUnits(payload []byte) [][]byte {
	if len(payload) < 1 {
		return nil
	}
	nalType := payload[0] & 0x1F
	switch {
	case nalType >= 1 && nalType <= 23:
		return [][]byte{payload}
	case nalType == 24: // STAP-A
		var nals [][]byte
		i := 1
		for i+2 <= len(payload) {
			size := int(payload[i])<<8 | int(payload[i+1])
			i += 2
			if size <= 0 || i+size > len(payload) {
				return nals
			}
			nals = append(nals, payload[i:i+size])
			i += size
		}
		return nals
	case nalType == 28: // FU-A
		if len(payload) < 2 || payload[1]&0x80 == 0 {
			return nil
		}
		// Reconstruct the NAL header from the FU indicator (F/NRI) and FU header type.
		hdr := (payload[0] & 0xE0) | (payload[1] & 0x1F)
		nal := make([]byte, 1+len(payload)-2)
		nal[0] = hdr
		copy(nal[1:], payload[2:])
		return [][]byte{nal}
	}
	return nil
}

// h264PayloadHasNAL reports whether payload carries a NAL of the given type.
func h264PayloadHasNAL(payload []byte, want byte) bool {
	for _, t := range h264NALTypes(payload) {
		if t == want {
			return true
		}
	}
	return false
}

// h264SPSProfileLevelID returns the three-byte profile-level-id from an SPS
// NAL (including the NAL header), or ("", false) if the NAL is too short.
func h264SPSProfileLevelID(sps []byte) (string, bool) {
	if len(sps) < 4 || sps[0]&0x1F != 7 {
		return "", false
	}
	return fmt.Sprintf("%02x%02x%02x", sps[1], sps[2], sps[3]), true
}

// h264ParamCache remembers the latest in-band SPS and PPS so a late-joining
// viewer can be given parameter sets before its first IDR.
type h264ParamCache struct {
	mu  sync.Mutex
	sps []byte
	pps []byte
}

func (c *h264ParamCache) clear() {
	c.mu.Lock()
	c.sps, c.pps = nil, nil
	c.mu.Unlock()
}

func (c *h264ParamCache) observe(payload []byte) {
	for _, nal := range h264NALUnits(payload) {
		if len(nal) == 0 {
			continue
		}
		switch nal[0] & 0x1F {
		case 7:
			c.mu.Lock()
			c.sps = append([]byte(nil), nal...)
			c.mu.Unlock()
		case 8:
			c.mu.Lock()
			c.pps = append([]byte(nil), nal...)
			c.mu.Unlock()
		}
	}
}

// prefixBefore returns SPS/PPS RTP packets to write ahead of pkt when pkt is
// about to open a peer's stream gate but does not already carry both sets.
// Timestamps and payload type match pkt; sequence numbers are placeholders —
// Peer.nextVideoRTP numbers them per peer so a restart cannot collide with
// SRTP anti-replay. Returns nil when reinjection is unnecessary or the
// cache is incomplete.
func (c *h264ParamCache) prefixBefore(pkt *rtp.Packet) []*rtp.Packet {
	hasSPS := h264PayloadHasNAL(pkt.Payload, 7)
	hasPPS := h264PayloadHasNAL(pkt.Payload, 8)
	if hasSPS && hasPPS {
		return nil
	}
	c.mu.Lock()
	sps, pps := c.sps, c.pps
	c.mu.Unlock()
	var out []*rtp.Packet
	if !hasSPS && len(sps) > 0 {
		out = append(out, h264ParamRTP(pkt, sps))
	}
	if !hasPPS && len(pps) > 0 {
		out = append(out, h264ParamRTP(pkt, pps))
	}
	return out
}

func h264ParamRTP(template *rtp.Packet, nal []byte) *rtp.Packet {
	p := &rtp.Packet{
		Header: rtp.Header{
			Version:        template.Version,
			Padding:        false,
			Extension:      false,
			Marker:         false,
			PayloadType:    template.PayloadType,
			SequenceNumber: template.SequenceNumber, // rewritten by Peer.nextVideoRTP
			Timestamp:      template.Timestamp,
			SSRC:           template.SSRC,
		},
		Payload: append([]byte(nil), nal...),
	}
	return p
}

// h264GateOpenInfo is a bounded diagnostic summary for the packet that opens
// an H.264 viewer's stream gate.
func h264GateOpenInfo(payload []byte, injected int) string {
	types := h264NALTypes(payload)
	profile := ""
	for _, nal := range h264NALUnits(payload) {
		if id, ok := h264SPSProfileLevelID(nal); ok {
			profile = id
			break
		}
	}
	if profile == "" {
		return fmt.Sprintf("nal=%v inject=%d", types, injected)
	}
	return fmt.Sprintf("nal=%v sps=%s inject=%d", types, profile, injected)
}
