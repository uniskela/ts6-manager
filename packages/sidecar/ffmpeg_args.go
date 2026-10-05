package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

// FFmpeg's HLS demuxer reuses one HTTP connection (http_persistent defaults
// to 1). A playlist whose segments alternate between hosts, or between edge
// addresses of one hostname, then stalls: the kept connection is pinned to
// the first server, and the next segment never arrives cleanly. Opening a
// new connection per segment avoids that. The option belongs to the HLS
// demuxer only — passing it to MPEG-TS or MP4 makes ffmpeg refuse the input.

const (
	httpPersistentAuto = "auto"
	httpPersistentOff  = "0" // pass -http_persistent 0 for live and playlist URLs
	httpPersistentOn   = "1" // leave FFmpeg's own default alone
	hlsSniffTimeout    = 3 * time.Second
	hlsSniffBytes      = 512
	ffmpegHLSUserAgent = "Lavf/59.27.100" // bookworm ffmpeg 5.1; many IPTV panels allow Lavf
)

func httpPersistentMode() string {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FFMPEG_HTTP_PERSISTENT"))) {
	case "", httpPersistentAuto:
		return httpPersistentAuto
	case httpPersistentOff, "off", "false", "no":
		return httpPersistentOff
	case httpPersistentOn, "on", "true", "yes":
		return httpPersistentOn
	default:
		log.Printf("[FFmpeg] Unrecognized FFMPEG_HTTP_PERSISTENT value; using auto")
		return httpPersistentAuto
	}
}

func sourcePath(source string) string {
	if u, err := url.Parse(source); err == nil && u.Path != "" {
		return u.Path
	}
	cut := source
	if i := strings.IndexAny(cut, "?#"); i >= 0 {
		cut = cut[:i]
	}
	return cut
}

// hlsPlaylistURL reports whether the URL path (query and fragment stripped)
// ends in an HLS playlist suffix. Opaque IPTV URLs do not match; those are
// sniffed when the source mode is live.
func hlsPlaylistURL(source string) bool {
	ext := strings.ToLower(path.Ext(sourcePath(source)))
	return ext == ".m3u8" || ext == ".m3u"
}

// nonHLSMediaURL is a remote URL whose path names a single media file.
// Those are not sniffed: a live MPEG-TS .ts URL is one connection, and
// http_persistent is not a valid option for it.
func nonHLSMediaURL(source string) bool {
	switch strings.ToLower(path.Ext(sourcePath(source))) {
	case ".ts", ".mp4", ".m4v", ".mkv", ".webm", ".mp3", ".aac", ".flv", ".mpd", ".mov", ".m4a":
		return true
	default:
		return false
	}
}

// disablePersistentHTTP reports whether this input should get
// -http_persistent 0. sniffed is true when a live probe saw an HLS playlist.
func disablePersistentHTTP(mode, input string, sniffed map[string]bool) bool {
	if !isRemoteSource(input) {
		return false
	}
	switch httpPersistentMode() {
	case httpPersistentOn:
		return false
	case httpPersistentOff:
		return mode == modeLive || hlsPlaylistURL(input)
	default:
		return hlsPlaylistURL(input) || sniffed[input]
	}
}

// detectLiveHLS probes live remote inputs that are not already named as
// playlists. The result is consumed by buildFFmpegArgs. Playlist suffixes
// are decided there without a probe.
func detectLiveHLS(req SourceRequest, proxy *egressProxy) map[string]bool {
	if httpPersistentMode() != httpPersistentAuto {
		return nil
	}
	mode := resolveSourceMode(req.Mode, req.Source)
	if mode != modeLive {
		return nil
	}
	proxyURL := ""
	if proxy != nil {
		proxyURL = proxy.URL()
	}
	found := map[string]bool{}
	seen := map[string]bool{}
	for _, input := range []string{req.Source, req.AudioSource} {
		if input == "" || seen[input] || !isRemoteSource(input) || hlsPlaylistURL(input) || nonHLSMediaURL(input) {
			continue
		}
		seen[input] = true
		hls, err := sniffHLSPlaylist(input, proxyURL)
		if err != nil {
			log.Printf("[FFmpeg] Could not inspect live input for HLS; leaving persistent HTTP unchanged")
			continue
		}
		if hls {
			found[input] = true
			log.Printf("[FFmpeg] Live HTTP input is an HLS playlist; opening a new connection per segment")
			continue
		}
		log.Printf("[FFmpeg] Live HTTP input is not an HLS playlist; leaving persistent HTTP at FFmpeg's default")
	}
	return found
}

func playlistBytesAreHLS(body []byte) bool {
	body = bytes.TrimSpace(body)
	body = bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF})
	body = bytes.TrimSpace(body)
	return bytes.HasPrefix(bytes.ToUpper(body), []byte("#EXTM3U"))
}

// sniffHLSPlaylist reads the start of source. A nil error means the response
// was read: true when it is an HLS playlist, false when it is not. A non-nil
// error means the probe did not complete; the caller leaves FFmpeg's default
// in place. proxyURL, when set, is the sidecar egress proxy so redirects stay
// on the checked path.
func sniffHLSPlaylist(source, proxyURL string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hlsSniffTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", ffmpegHLSUserAgent)
	req.Header.Set("Accept-Encoding", "identity")
	transport := &http.Transport{
		Proxy:                 nil,
		DisableCompression:    true,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: hlsSniffTimeout,
	}
	if proxyURL != "" {
		parsed, err := url.Parse(proxyURL)
		if err != nil {
			return false, err
		}
		transport.Proxy = http.ProxyURL(parsed)
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   hlsSniffTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, hlsSniffBytes))
	if err != nil && len(body) == 0 {
		return false, err
	}
	return playlistBytesAreHLS(body), nil
}

// extraFFmpegInputArgs is FFMPEG_EXTRA_INPUT_ARGS, applied to each remote
// input after the built-in input options. A value FFmpeg understands
// (including -http_persistent) wins over the default because it comes later.
// Invalid values are logged and ignored so a typo does not kill the stream.
func extraFFmpegInputArgs() []string {
	return extraFFmpegArgs("FFMPEG_EXTRA_INPUT_ARGS")
}

// extraFFmpegOutputArgs is FFMPEG_EXTRA_OUTPUT_ARGS, inserted immediately
// before each RTP muxer.
func extraFFmpegOutputArgs() []string {
	return extraFFmpegArgs("FFMPEG_EXTRA_OUTPUT_ARGS")
}

func extraFFmpegArgs(envName string) []string {
	raw := strings.TrimSpace(os.Getenv(envName))
	if raw == "" {
		return nil
	}
	args, err := parseFFmpegArgs(raw)
	if err != nil {
		log.Printf("[FFmpeg] Ignoring %s: %v", envName, err)
		return nil
	}
	if err := validateExtraFFmpegArgs(args); err != nil {
		log.Printf("[FFmpeg] Ignoring %s: %v", envName, err)
		return nil
	}
	return args
}

// parseFFmpegArgs splits an argument string into argv without invoking a
// shell. Single quotes are literal. Inside double quotes, \r, \n, \t and \\
// expand so an HTTP header value can carry a real CRLF.
func parseFFmpegArgs(raw string) ([]string, error) {
	var args []string
	var b strings.Builder
	inSingle, inDouble, quoted := false, false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case inSingle:
			if c == '\'' {
				inSingle = false
				continue
			}
			b.WriteByte(c)
		case inDouble:
			if c == '\\' && i+1 < len(raw) {
				i++
				switch raw[i] {
				case 'n':
					b.WriteByte('\n')
				case 'r':
					b.WriteByte('\r')
				case 't':
					b.WriteByte('\t')
				default:
					b.WriteByte(raw[i])
				}
				continue
			}
			if c == '"' {
				inDouble = false
				continue
			}
			b.WriteByte(c)
		case c == '\'':
			inSingle = true
			quoted = true
		case c == '"':
			inDouble = true
			quoted = true
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if b.Len() > 0 || quoted {
				args = append(args, b.String())
				b.Reset()
				quoted = false
			}
		default:
			b.WriteByte(c)
		}
	}
	if inSingle || inDouble {
		return nil, errors.New("unbalanced quote")
	}
	if b.Len() > 0 || quoted {
		args = append(args, b.String())
	}
	return args, nil
}

func validateExtraFFmpegArgs(args []string) error {
	for _, token := range args {
		if token == "-i" {
			return errors.New("refusing -i because it would add another input")
		}
		if bareURLToken(token) {
			return errors.New("refusing a bare URL because it would add another input or output")
		}
	}
	return nil
}

func bareURLToken(token string) bool {
	scheme, rest, ok := strings.Cut(token, "://")
	if !ok || scheme == "" || rest == "" {
		return false
	}
	for _, r := range scheme {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '+' && r != '-' && r != '.' {
			return false
		}
	}
	return true
}
