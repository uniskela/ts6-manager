package main

import (
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func awaitAV1Watcher(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("AV1 watcher did not complete")
	}
}

// Drive completion and the observation clock directly: no scheduling sleeps
// are needed to cover both choices when exit and a polling tick are ready.
func TestAV1WatcherCompletionOrdering(t *testing.T) {
	for _, tc := range []struct {
		name, diagnostic string
		exitErr          error
		generation       uint64
		retry            bool
	}{
		{"fatal video", "Error while decoding stream #0:2: Invalid data found when processing input\n", errors.New("exit status 1"), 7, true},
		{"normal EOF despite earlier error", "Error while decoding stream #0:2: Invalid data found when processing input\n", nil, 7, false},
		{"network error", "[https @ 0x1] Connection reset by peer\n", errors.New("exit status 1"), 7, false},
		{"audio error", "Error while decoding stream #0:0: Invalid data found when processing input\n", errors.New("exit status 1"), 7, false},
		{"explicit stop", "Error while decoding stream #0:2: Invalid data found when processing input\n", errors.New("signal: killed"), 8, false},
		{"stream replacement", "Error while decoding stream #0:2: Invalid data found when processing input\n", errors.New("exit status 1"), 9, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for i := 0; i < 50; i++ {
				s := &Sidecar{ffmpegGen: tc.generation}
				tail := &tailBuffer{processError: tc.exitErr}
				tail.Write([]byte(tc.diagnostic))
				done := make(chan struct{})
				close(done)
				tick := make(chan time.Time, 1)
				tick <- time.Time{}
				retries := 0
				s.watchAV1DecodeFailure(SourceRequest{}, "cuda", 2, 7, done, tail, tick, nil, func(req SourceRequest) (EncoderSession, error) {
					retries++
					if req.av1FallbackReason == "" {
						t.Error("retry lost its decoder failure reason")
					}
					return EncoderSession{}, nil
				})
				want := 0
				if tc.retry {
					want = 1
				}
				if retries != want {
					t.Fatalf("retries=%d, want %d", retries, want)
				}
			}
		})
	}
}

func TestAV1WatcherWindowExpiry(t *testing.T) {
	s := &Sidecar{ffmpegGen: 7}
	deadline := make(chan time.Time, 1)
	deadline <- time.Time{}
	s.watchAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, make(chan struct{}), &tailBuffer{}, nil, deadline, func(SourceRequest) (EncoderSession, error) {
		t.Fatal("expired window restarted")
		return EncoderSession{}, nil
	})
}

func TestAV1WatcherRechecksGenerationAfterWaitingForLock(t *testing.T) {
	for _, cancellation := range []string{"explicit stop", "stream replacement", "backend cancellation"} {
		t.Run(cancellation, func(t *testing.T) {
			s := &Sidecar{ffmpegGen: 7}
			tail := &tailBuffer{}
			tail.Write([]byte("Error while decoding stream #0:0: Invalid data found when processing input\n"))
			ticks := make(chan time.Time)
			watcherDone := make(chan struct{})
			s.ffmpegLock.Lock()
			go func() {
				defer close(watcherDone)
				s.watchAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, make(chan struct{}), tail, ticks, nil, func(SourceRequest) (EncoderSession, error) {
					t.Error("stale watcher restarted stream")
					return EncoderSession{}, nil
				})
			}()
			ticks <- time.Time{} // watcher has observed the failure before cancellation
			s.StopFFmpegLocked()
			s.ffmpegLock.Unlock()
			awaitAV1Watcher(t, watcherDone)
		})
	}
}

func TestAV1RetryReapsOldProcessBeforeLaunchingAndRunsOnce(t *testing.T) {
	installFakeFFmpeg(t, "exec sleep 30\n")
	s := &Sidecar{ffmpegGen: 7}
	defer s.Stop()
	done, tail, err := s.launchFFmpegLocked(nil, 7, newHealthTracker(modeLive, 0, nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	old := s.ffmpeg
	tail.Write([]byte("Error while decoding stream #0:0: Invalid data found when processing input\n"))
	// Retain the reason even when progress messages have evicted the stderr tail.
	tail.Write([]byte(strings.Repeat("progress\n", 1000)))
	retries := 0
	restart := func(req SourceRequest) (EncoderSession, error) {
		retries++
		if !exited(done) || old.ProcessState == nil {
			t.Error("replacement launched before old process was reaped")
		}
		if !strings.Contains(req.av1FallbackReason, "Error while decoding") {
			t.Errorf("lost failure evidence: %q", req.av1FallbackReason)
		}
		atomic.AddUint64(&s.ffmpegGen, 1) // successful replacement owns a new generation
		return EncoderSession{}, nil
	}
	s.retryAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, done, tail, restart)
	s.retryAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, done, tail, restart)
	if retries != 1 {
		t.Fatalf("retries=%d, want precisely one", retries)
	}
}

func TestStopFFmpegReapsProcessBeforeReturning(t *testing.T) {
	installFakeFFmpeg(t, "exec sleep 30\n")
	s := &Sidecar{}
	done, _, err := s.launchFFmpegLocked(nil, 0, newHealthTracker(modeLive, 0, nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	old := s.ffmpeg
	s.StopFFmpegLocked()
	if !exited(done) || old.ProcessState == nil || s.ffmpeg != nil || s.ffmpegDone != nil {
		t.Fatal("stop returned before releasing the process")
	}
}

func TestAV1TerminalFailureIsNotPublishedBeforeRetry(t *testing.T) {
	installFakeFFmpeg(t, "echo 'Error while decoding stream #0:0: Invalid data found when processing input' >&2\nexit 1\n")
	s := &Sidecar{ffmpegGen: 7, encoder: EncoderSession{gen: 7, State: "running", Decoder: "av1 (cuda)"}}
	defer s.Stop()
	done, tail, err := s.launchFFmpegLocked(nil, 7, newHealthTracker(modeLive, 0, nil), 0)
	if err != nil {
		t.Fatal(err)
	}
	awaitAV1Watcher(t, done)
	if got := s.encoderSession(); got.State != "running" || got.ExitError != "" {
		t.Fatalf("published terminal status before fallback decision: %+v", got)
	}
	retries := 0
	s.watchAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, done, tail, nil, nil, func(req SourceRequest) (EncoderSession, error) {
		retries++
		s.statusMu.Lock()
		s.encoder.Decoder = "libdav1d"
		s.encoder.DecoderFallbackReason = req.av1FallbackReason
		s.statusMu.Unlock()
		return s.encoderSession(), nil
	})
	if retries != 1 || s.encoderSession().Decoder != "libdav1d" {
		t.Fatal("terminal failure did not commit its retry")
	}
}

func TestAV1CompletionRacingWindowDeadline(t *testing.T) {
	for _, within := range []bool{true, false} {
		for i := 0; i < 50; i++ {
			limit := time.Now().Add(-time.Second)
			exitAt := limit.Add(time.Second)
			if within {
				exitAt = limit.Add(-time.Second)
			}
			tail := &tailBuffer{processError: errors.New("exit status 1"), processExitedAt: exitAt, decodeDeadline: limit}
			tail.Write([]byte("Error while decoding stream #0:0: Invalid data found when processing input\n"))
			done := make(chan struct{})
			close(done)
			deadline := make(chan time.Time, 1)
			deadline <- limit
			s := &Sidecar{ffmpegGen: 7}
			retries := 0
			s.watchAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, done, tail, nil, deadline, func(SourceRequest) (EncoderSession, error) { retries++; return EncoderSession{}, nil })
			want := 0
			if within {
				want = 1
			}
			if retries != want {
				t.Fatalf("completed within window=%v: retries=%d, want %d", within, retries, want)
			}
		}
	}
}

// A stream that ends cleanly inside the hardware startup check has finished:
// it is not started again on another decoder or encoder.
func TestAV1StartupEOFIsNotReplayed(t *testing.T) {
	calls := installFakeFFmpeg(t, "case \"$*\" in *av1-probe*) exit 0 ;; esac\nexit 0\n")
	t.Setenv("VIDEO_HW_DECODE", "1")
	s := NewSidecar()
	defer s.Stop()
	got, err := s.StartFFmpeg(SourceRequest{Source: "https://example.com/v.webm", VideoCodec: "av1", Encoder: "h264_nvenc", Volume: 100, SilentAudio: true})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "exited" || got.ExitError != "" || got.DecoderFallbackReason != "" || got.FallbackReason != "" {
		t.Fatalf("a finished stream must stay finished: %+v", got)
	}
	if runs := streamRuns(t, calls, 1); len(runs) != 1 {
		t.Fatalf("a finished stream was started again:\n%s", strings.Join(runs, "\n"))
	}
}

func TestAV1RetryValidationFailurePublishesTerminalStatus(t *testing.T) {
	s := &Sidecar{ffmpegGen: 7, encoder: EncoderSession{gen: 7, State: "running"}}
	tail := &tailBuffer{processError: errors.New("exit status 1")}
	tail.Write([]byte("Error while decoding stream #0:0: Invalid data found when processing input\n"))
	done := make(chan struct{})
	close(done)
	s.retryAV1DecodeFailure(SourceRequest{}, "cuda", 0, 7, done, tail, func(SourceRequest) (EncoderSession, error) {
		return EncoderSession{}, errors.New("source no longer available")
	})
	if got := s.encoderSession(); got.State != "exited" || got.ExitError != "source no longer available" {
		t.Fatalf("failed retry remained pending: %+v", got)
	}
}
