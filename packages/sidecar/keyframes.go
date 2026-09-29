package main

// isKeyframeStart reports whether an RTP payload begins a frame a new viewer
// can start decoding from. The stream gate stays closed until one arrives.
func isKeyframeStart(codec string, payload []byte) bool {
	switch codec {
	case codecVP9:
		return isVP9KeyframeStart(payload)
	case codecH264:
		return isH264KeyframeStart(payload)
	default:
		return isVP8KeyframeStart(payload)
	}
}

// isVP9KeyframeStart parses the VP9 RTP payload descriptor and then the
// uncompressed frame header of the first packet of a frame.
func isVP9KeyframeStart(payload []byte) bool {
	if len(payload) < 2 {
		return false
	}
	b0 := payload[0]
	iBit := b0&0x80 != 0
	pBit := b0&0x40 != 0
	lBit := b0&0x20 != 0
	fBit := b0&0x10 != 0
	bBit := b0&0x08 != 0
	vBit := b0&0x02 != 0

	if !bBit || pBit {
		return false
	}
	i := 1
	if iBit {
		if len(payload) <= i {
			return false
		}
		if payload[i]&0x80 != 0 {
			i += 2
		} else {
			i++
		}
	}
	if lBit {
		i++
		if !fBit {
			i++ // TL0PICIDX
		}
	}
	if vBit {
		// Scalability structure is only sent with key frames; parsing it is
		// unnecessary to decide this is a key frame start.
		return true
	}
	if len(payload) <= i {
		return false
	}

	h := payload[i]
	// frame_marker (2 bits) must be 0b10.
	if h>>6 != 0x2 {
		return false
	}
	profile := (h>>5)&0x1 | ((h>>4)&0x1)<<1
	bit := 4 // marker (2) + profile bits (2) consumed from the MSB
	if profile == 3 {
		bit++ // reserved_zero
	}
	showExisting := (h >> (7 - bit)) & 0x1
	bit++
	if showExisting == 1 {
		return false
	}
	frameType := (h >> (7 - bit)) & 0x1
	return frameType == 0
}

// isH264KeyframeStart opens the gate on SPS (sent in-band ahead of each IDR)
// or an IDR slice, covering single NAL, STAP-A and FU-A packetization.
func isH264KeyframeStart(payload []byte) bool {
	if len(payload) < 1 {
		return false
	}
	nalType := payload[0] & 0x1F
	switch {
	case nalType >= 1 && nalType <= 23:
		return h264IsKeyNal(nalType)
	case nalType == 24: // STAP-A
		i := 1
		for i+2 < len(payload) {
			size := int(payload[i])<<8 | int(payload[i+1])
			i += 2
			if size == 0 || i >= len(payload) {
				return false
			}
			if h264IsKeyNal(payload[i] & 0x1F) {
				return true
			}
			i += size
		}
		return false
	case nalType == 28: // FU-A
		if len(payload) < 2 {
			return false
		}
		start := payload[1]&0x80 != 0
		return start && h264IsKeyNal(payload[1]&0x1F)
	}
	return false
}

func h264IsKeyNal(t byte) bool {
	return t == 5 || t == 7
}
