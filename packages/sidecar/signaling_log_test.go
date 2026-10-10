package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

// oneRecord fails when marker starts its own log line or the record still holds CR/ESC.
func oneRecord(t *testing.T, out, marker string) {
	t.Helper()
	if strings.Contains(out, "\r") || strings.Contains(out, "\n"+marker) || strings.Contains(out, "\x1b") {
		t.Fatalf("untrusted text broke the log record:\n%s", out)
	}
	if !strings.Contains(out, marker) {
		t.Fatalf("log dropped diagnostic %q:\n%s", marker, out)
	}
}

func postJSON(t *testing.T, h http.HandlerFunc, payload any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestBufferedICEErrorStaysOneLogRecord(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	buf := captureLog(t)
	s := NewSidecar()
	const id = "log-ice-buf"
	offer, err := s.CreatePeer(id, "")
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer(id)

	const marker = "ZZLOGSPLIT"
	bad := "candidate:bad\r\n" + marker + "\n\x1b"
	if err := s.AddICECandidate(id, bad, "0", 0); err != nil {
		t.Fatalf("buffer: %v", err)
	}
	if err := s.SetAnswer(id, answerFor(t, offer)); err != nil {
		t.Fatalf("SetAnswer: %v", err)
	}
	out := buf.String()
	oneRecord(t, out, marker)
	if !strings.Contains(out, id) {
		t.Fatalf("log missing peer %s:\n%s", id, out)
	}
	if err := s.AddICECandidate(id, hostCandidate(50021), "0", 0); err != nil {
		t.Fatalf("normal candidate after a bad early one: %v", err)
	}
}

func TestImmediateICEErrorStaysOneLogRecord(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()
	const id = "log-ice-now"
	offer, err := s.CreatePeer(id, "")
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer(id)
	if err := s.SetAnswer(id, answerFor(t, offer)); err != nil {
		t.Fatalf("SetAnswer: %v", err)
	}

	buf := captureLog(t)
	const marker = "ZZLOGSPLIT"
	rec := postJSON(t, s.postPeerICE, map[string]any{
		"id": id, "candidate": "candidate:bad\r\n" + marker + "\n\x1b",
		"sdpMid": "0", "sdpMLineIndex": 0,
	})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	oneRecord(t, buf.String(), marker)
	if err := s.AddICECandidate(id, hostCandidate(50022), "0", 0); err != nil {
		t.Fatalf("normal candidate after a bad one: %v", err)
	}
}

func TestSDPErrorLogStaysOneRecord(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()
	const id = "log-sdp"
	offer, err := s.CreatePeer(id, "")
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer(id)

	const marker = "ZZLOGSPLIT"
	sdp := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nb=NOPE:" + marker + "\x1b\r\n"
	parseErr := s.SetAnswer(id, sdp)
	if parseErr == nil {
		t.Fatal("expected SDP error")
	}
	if strings.ContainsAny(parseErr.Error(), "\r\n") {
		t.Fatalf("SDP parser error kept a line break: %q", parseErr.Error())
	}

	buf := captureLog(t)
	rec := postJSON(t, s.postPeerAnswer, map[string]string{"id": id, "sdp": sdp})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	out := buf.String()
	if strings.Contains(out, "\r") || strings.Contains(out, "\x1b") {
		t.Fatalf("control character reached the log: %q", out)
	}
	if strings.Contains(parseErr.Error(), marker) && !strings.Contains(out, marker) {
		t.Fatalf("log dropped SDP diagnostic: err=%q log=%s", parseErr.Error(), out)
	}
	if err := s.SetAnswer(id, answerFor(t, offer)); err != nil {
		t.Fatalf("valid answer after a bad SDP: %v", err)
	}
}
