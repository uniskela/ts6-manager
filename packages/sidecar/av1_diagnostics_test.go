package main

import (
	"os"
	"strings"
	"testing"
)

func TestAV1VersionedDecodeDiagnostics(t *testing.T) {
	for _, version := range []string{"5.1", "6.1", "7.0", "8.0", "9.0.1"} {
		t.Run(version, func(t *testing.T) {
			fixture, err := os.ReadFile("testdata/av1-errors/ffmpeg-" + version + ".log")
			if err != nil {
				t.Fatal(err)
			}
			for _, line := range strings.Split(strings.TrimSpace(string(fixture)), "\n") {
				// Exercise every possible pipe-write boundary, including inside indexes.
				for split := 0; split <= len(line); split++ {
					tail := &tailBuffer{}
					tail.Write([]byte(line[:split]))
					tail.Write([]byte(line[split:] + "\n"))
					tail.Write([]byte(strings.Repeat("unrelated output\n", 1000)))
					if !av1DecodeFailed(tail, 1) {
						t.Fatalf("lost stream 1 diagnostic at split %d: %s", split, line)
					}
					if av1DecodeFailed(tail, 0) || av1DecodeFailed(tail, 10) {
						t.Fatal("matched another stream")
					}
					if !strings.Contains(av1DecodeFailureReason(tail, 1), "decoder") && !strings.Contains(av1DecodeFailureReason(tail, 1), "ecoding") {
						t.Fatal("lost failure reason")
					}
				}
			}
		})
	}
}

func TestAV1DiagnosticsRejectUnrelatedFailures(t *testing.T) {
	for _, line := range []string{
		"[aist#0:1/aac @ 0x1234] Decoding error: Invalid data found when processing input",
		"[vist#1:1/av1 @ 0x1234] Decoding error: Invalid data found when processing input",
		"[vist#0:1/h264 @ 0x1234] Decoding error: Invalid data found when processing input",
		"[vist#0:1/av1 @ 0x1234] [dec:av1 @ 0x5678] Error submitting EOF to decoder: End of file",
		"[vist#0:1/av1 @ 0x1234] [dec:av1 @ 0x5678] Error processing packet in decoder: Connection reset by peer",
		"[http @ 0x1234] Invalid data found when processing input",
		"Error while processing the decoded data for stream #0:1",
		"[av1 @ 0x1234] Your platform doesn't support hardware accelerated AV1 decoding",
		"Error while decoding stream #1:1: Invalid data found when processing input",
		"[vist#0:10/av1 @ 0x1234] Decoding error: Invalid data found when processing input",
	} {
		t.Run(line, func(t *testing.T) {
			tail := &tailBuffer{}
			tail.Write([]byte(line + "\n"))
			if av1DecodeFailed(tail, 1) {
				t.Fatal("unrelated failure triggers AV1 retry")
			}
		})
	}
}

func TestAV1DiagnosticHugeWriteAndUnterminatedLine(t *testing.T) {
	tail := &tailBuffer{}
	diagnostic := "Error while decoding stream #0:1: Invalid data found when processing input"
	tail.Write([]byte(diagnostic))
	if !av1DecodeFailed(tail, 1) {
		t.Fatal("missing unterminated diagnostic")
	}
	tail.Write([]byte("\n" + strings.Repeat("x", 20000) + "\n"))
	if !av1DecodeFailed(tail, 1) {
		t.Fatal("huge write lost diagnostic")
	}
	fresh := &tailBuffer{}
	fresh.Write([]byte(diagnostic + "\n" + strings.Repeat("x", 20000)))
	if !av1DecodeFailed(fresh, 1) {
		t.Fatal("single overflowing write lost diagnostic")
	}
}

func TestAV1DiagnosticConcurrentReader(t *testing.T) {
	tail := &tailBuffer{}
	started, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		<-started
		for i := 0; i < 1000; i++ {
			tail.Write([]byte("Error while decoding stream #0:1: Invalid data found when processing input\n"))
		}
	}()
	close(started)
	for i := 0; i < 1000; i++ {
		av1DecodeFailed(tail, 1)
		tail.summary()
	}
	<-done
	if !av1DecodeFailed(tail, 1) {
		t.Fatal("missing concurrent diagnostic")
	}
}
