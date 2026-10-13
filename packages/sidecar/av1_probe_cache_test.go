package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAV1ProbeFixtureSHA256(t *testing.T) {
	const want = "272b07e79cdbb9968944c9d628bf7e037e3cbeae7ab6844fd6d3a49fd3aa033d"
	if got := fmt.Sprintf("%x", sha256.Sum256(av1ProbeSample)); got != want {
		t.Fatalf("embedded AV1 fixture hash = %s, want %s; investigate fixture changes", got, want)
	}
}

func TestCapabilitiesSkipAV1ProbeWhenHardwareDecodeDisabled(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "0")
	vaapiDevice(t, false)
	var av1Calls atomic.Int32
	c := &capabilityCache{run: func(ctx context.Context, args []string) (string, error) {
		if strings.Contains(strings.Join(args, " "), "-c:v av1") {
			av1Calls.Add(1)
		}
		return "", nil
	}}
	caps := c.get(false)
	if av1Calls.Load() != 0 || caps.AV1HwDecode || len(caps.AV1Decode) != 0 {
		t.Fatalf("hardware decoding off: %d unnecessary AV1 probes, capabilities %+v", av1Calls.Load(), caps.AV1Decode)
	}
}

func TestAV1CapabilityProbeDoesNotBlockCachedEncoderReads(t *testing.T) {
	t.Setenv("VIDEO_HW_DECODE", "1")
	vaapiDevice(t, false)
	entered, release := make(chan struct{}), make(chan struct{})
	old := &EncoderCapabilities{}
	c := &capabilityCache{caps: old, run: func(ctx context.Context, args []string) (string, error) {
		if strings.Contains(strings.Join(args, " "), "-c:v av1") {
			close(entered)
			<-release
		}
		return "", nil
	}}
	done := make(chan struct{})
	go func() { c.get(true); close(done) }()
	t.Cleanup(func() { close(release); <-done })
	<-entered
	read := make(chan *EncoderCapabilities, 1)
	go func() { read <- c.peek() }()
	select {
	case got := <-read:
		if got != old {
			t.Error("cached capability changed before refresh completed")
		}
	case <-time.After(time.Second):
		t.Error("AV1 probe holds shared capability lock and blocks stream startup")
	}
	// release is deferred so a failing assertion cannot leak the probe goroutine.
}
