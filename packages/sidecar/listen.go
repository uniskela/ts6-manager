package main

import (
	"net"
	"os"
	"strconv"
	"strings"
)

// httpListenAddr is where the HTTP API listens. SIDECAR_HOST unset keeps the
// all-interfaces listener the Docker images rely on; a native install sets it
// to the one address the backend reaches (127.0.0.1 when both share a host).
func httpListenAddr(port int) string {
	return net.JoinHostPort(strings.TrimSpace(os.Getenv("SIDECAR_HOST")), strconv.Itoa(port))
}
