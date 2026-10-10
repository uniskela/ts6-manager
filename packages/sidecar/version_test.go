package main

import (
	"bytes"
	"runtime"
	"testing"
)

func TestPrintVersionIfRequested(t *testing.T) {
	old := version
	version = "1.2.3"
	defer func() { version = old }()

	for _, flag := range []string{"-version", "--version", "version"} {
		var out bytes.Buffer
		if !printVersionIfRequested([]string{"sidecar", flag}, &out) {
			t.Fatalf("%s: not handled", flag)
		}
		want := "ts6-media-sidecar 1.2.3 " + runtime.GOOS + "/" + runtime.GOARCH + "\n"
		if out.String() != want {
			t.Fatalf("%s: got %q, want %q", flag, out.String(), want)
		}
	}

	var out bytes.Buffer
	if printVersionIfRequested([]string{"sidecar"}, &out) || printVersionIfRequested([]string{"sidecar", "--other"}, &out) {
		t.Fatal("handled a non-version invocation")
	}
	if out.Len() != 0 {
		t.Fatalf("unexpected output %q", out.String())
	}
}

func TestBuildInfo(t *testing.T) {
	info := buildInfo()
	if info["version"] != version || info["os"] != runtime.GOOS || info["arch"] != runtime.GOARCH {
		t.Fatalf("unexpected build info %v", info)
	}
}
