package main

import (
	"fmt"
	"io"
	"runtime"
)

// version is the TS6 Manager release this binary was built from. Release
// builds and the Docker images set it with -ldflags "-X main.version=X.Y.Z";
// a plain `go build` leaves "dev". The backend compares it with its own
// version (GET /health), so it carries no leading "v".
var version = "dev"

// buildInfo is the identity reported by GET /health and --version.
func buildInfo() map[string]string {
	return map[string]string{
		"version": version,
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
	}
}

// printVersionIfRequested handles `sidecar --version` so an installer or
// operator can check a binary without starting the media ports.
func printVersionIfRequested(args []string, w io.Writer) bool {
	if len(args) < 2 {
		return false
	}
	switch args[1] {
	case "-version", "--version", "version":
		fmt.Fprintf(w, "ts6-media-sidecar %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
		return true
	}
	return false
}
