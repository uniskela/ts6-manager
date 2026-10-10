package main

import "testing"

func TestHTTPListenAddr(t *testing.T) {
	cases := []struct{ host, want string }{
		{"", ":9800"},
		{"  ", ":9800"},
		{"127.0.0.1", "127.0.0.1:9800"},
		{"::1", "[::1]:9800"},
	}
	for _, c := range cases {
		t.Setenv("SIDECAR_HOST", c.host)
		if got := httpListenAddr(9800); got != c.want {
			t.Errorf("SIDECAR_HOST=%q: got %q, want %q", c.host, got, c.want)
		}
	}
}
