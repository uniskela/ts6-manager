package main

import (
	"errors"
	"log"
	"net/url"
	"os"
	"path"
	"strings"
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
// ends in an HLS playlist suffix. Opaque IPTV URLs do not match; set
// FFMPEG_HTTP_PERSISTENT=0 to cover those without fetching the URL first.
func hlsPlaylistURL(source string) bool {
	ext := strings.ToLower(path.Ext(sourcePath(source)))
	return ext == ".m3u8" || ext == ".m3u"
}

// disablePersistentHTTP reports whether this input should get
// -http_persistent 0. The flag is valid only for the HLS demuxer.
func disablePersistentHTTP(mode, input string) bool {
	if !isRemoteSource(input) {
		return false
	}
	switch httpPersistentMode() {
	case httpPersistentOn:
		return false
	case httpPersistentOff:
		return mode == modeLive || hlsPlaylistURL(input)
	default:
		return hlsPlaylistURL(input)
	}
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
