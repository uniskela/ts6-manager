package main

import (
	"strings"
	"testing"
)

func ffmpegArgLine(req SourceRequest) string {
	s := NewSidecar()
	spec, _ := lookupEncoder("vp8")
	return strings.Join(s.buildFFmpegArgs(req, spec, false), " ")
}

func TestHLSPlaylistURL(t *testing.T) {
	yes := []string{
		"https://cdn.example/live/index.m3u8",
		"https://cdn.example/live/index.M3U8?token=abc#f",
		"http://cdn.example/playlist.m3u",
		"https://cdn.example/a/b.m3u?x=1",
	}
	no := []string{
		"https://cdn.example/get.php?type=m3u8",
		"https://cdn.example/file.m3u8.mp4",
		"https://cdn.example/live.ts",
		"https://cdn.example/clip.mp4",
		"/data/music/clip.mp4",
		"https://cdn.example/playlist.m3u8.bak",
	}
	for _, u := range yes {
		if !hlsPlaylistURL(u) {
			t.Errorf("want playlist URL: %s", u)
		}
	}
	for _, u := range no {
		if hlsPlaylistURL(u) {
			t.Errorf("want non-playlist URL: %s", u)
		}
	}
}

func TestParseAndValidateExtraFFmpegArgs(t *testing.T) {
	got, err := parseFFmpegArgs(`-user_agent IPTV -headers "Referer: https://cdn.example/\r\n"`)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 || got[0] != "-user_agent" || got[1] != "IPTV" || got[2] != "-headers" {
		t.Fatalf("tokens: %#v", got)
	}
	if got[3] != "Referer: https://cdn.example/\r\n" {
		t.Fatalf("header value: %#v", got[3])
	}
	if err := validateExtraFFmpegArgs(got); err != nil {
		t.Fatal(err)
	}
	if _, err := parseFFmpegArgs(`-user_agent "unterminated`); err == nil {
		t.Fatal("unbalanced quote must fail")
	}
	if err := validateExtraFFmpegArgs([]string{"-reconnect", "1", "-i"}); err == nil {
		t.Fatal("-i must be refused")
	}
	if err := validateExtraFFmpegArgs([]string{"https://evil.example/out.ts"}); err == nil {
		t.Fatal("bare URL must be refused")
	}
	if err := validateExtraFFmpegArgs([]string{"rtp://127.0.0.1:9"}); err == nil {
		t.Fatal("rtp URL must be refused")
	}
}

func TestBuildFFmpegArgsDisablesPersistentHTTPForHLSOnly(t *testing.T) {
	playlist := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/a.m3u8?token=1", Volume: 100})
	if !strings.Contains(playlist, "-http_persistent 0") {
		t.Fatalf("playlist URL must disable persistent HTTP: %s", playlist)
	}
	if !strings.Contains(playlist, "-re -i https://cdn.example/a.m3u8?token=1") {
		t.Fatalf("-re must stay adjacent to -i: %s", playlist)
	}
	if strings.Index(playlist, "-http_persistent 0") > strings.Index(playlist, "-re -i") {
		t.Fatalf("persistent HTTP flag must be an input option: %s", playlist)
	}

	liveOpaque := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/get.php?type=m3u8", Mode: modeLive, Volume: 100})
	if strings.Contains(liveOpaque, "http_persistent") {
		t.Fatalf("opaque live URL is not assumed to be HLS: %s", liveOpaque)
	}
	livePlaylist := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/live.m3u8", Mode: modeLive, Volume: 100})
	if !strings.Contains(livePlaylist, "-http_persistent 0 -fflags +genpts+igndts+discardcorrupt -re -i") {
		t.Fatalf("live playlist must disable persistent HTTP and keep pacing: %s", livePlaylist)
	}

	vod := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/clip.mp4", Mode: modeVOD, Volume: 100})
	if strings.Contains(vod, "http_persistent") {
		t.Fatalf("progressive VOD must keep FFmpeg's default: %s", vod)
	}
	liveTS := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/live.ts", Mode: modeLive, Volume: 100})
	if strings.Contains(liveTS, "http_persistent") {
		t.Fatalf("live MPEG-TS must not get the HLS-only option: %s", liveTS)
	}
	local := ffmpegArgLine(SourceRequest{Source: "/data/music/clip.mp4", Volume: 100})
	if strings.Contains(local, "http_persistent") || strings.Contains(local, "-reconnect") {
		t.Fatalf("local file: %s", local)
	}

	t.Setenv("FFMPEG_HTTP_PERSISTENT", "1")
	if got := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/a.m3u8", Volume: 100}); strings.Contains(got, "http_persistent") {
		t.Fatalf("FFMPEG_HTTP_PERSISTENT=1 must restore FFmpeg's default: %s", got)
	}
	t.Setenv("FFMPEG_HTTP_PERSISTENT", "0")
	forced := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/get.php", Mode: modeLive, Volume: 100})
	if !strings.Contains(forced, "-http_persistent 0") {
		t.Fatalf("FFMPEG_HTTP_PERSISTENT=0 forces the flag for live inputs: %s", forced)
	}
	forcedVOD := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/clip.mp4", Mode: modeVOD, Volume: 100})
	if strings.Contains(forcedVOD, "http_persistent") {
		t.Fatalf("forcing the flag must not touch progressive VOD: %s", forcedVOD)
	}

	t.Setenv("FFMPEG_HTTP_PERSISTENT", "auto")
	t.Setenv("VIDEO_LIVE_PACING", "source")
	paced := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/a.m3u8", Mode: modeLive, Volume: 100})
	if strings.Contains(paced, "-re ") || !strings.Contains(paced, "-http_persistent 0") {
		t.Fatalf("source pacing drops -re and still disables persistent HTTP: %s", paced)
	}

	split := ffmpegArgLine(SourceRequest{
		Source:      "https://v.example/video.m3u8",
		AudioSource: "https://a.example/audio.mp4",
		Mode:        modeVOD,
		Volume:      100,
	})
	if strings.Count(split, "-http_persistent 0") != 1 {
		t.Fatalf("only the HLS input gets the flag: %s", split)
	}
}

func TestExtraFFmpegArgsOverrideAndReject(t *testing.T) {
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "-http_persistent 1 -user_agent IPTV")
	got := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/a.m3u8", Volume: 100})
	off := strings.Index(got, "-http_persistent 0")
	on := strings.Index(got, "-http_persistent 1")
	ua := strings.Index(got, "-user_agent IPTV")
	input := strings.Index(got, "-i https://cdn.example/a.m3u8")
	if off < 0 || on < 0 || ua < 0 || !(off < on && on < input && ua < input) {
		t.Fatalf("extra input args must follow the default and stay before -i: %s", got)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "-user_agent LOCAL")
	local := ffmpegArgLine(SourceRequest{Source: "/data/music/clip.mp4", Volume: 100})
	if strings.Contains(local, "LOCAL") || strings.Contains(local, "-user_agent") {
		t.Fatalf("extra input args are remote-only: %s", local)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", `-headers "Referer: https://cdn.example/\r\n"`)
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "-metadata title=Channel")
	remote := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/clip.mp4", Mode: modeVOD, Volume: 100})
	if !strings.Contains(remote, "Referer: https://cdn.example/") {
		t.Fatalf("header value may contain a URL: %s", remote)
	}
	if strings.Count(remote, "-metadata title=Channel -f rtp") != 2 {
		t.Fatalf("extra output args go before each RTP muxer: %s", remote)
	}
	if strings.Contains(remote, "http_persistent") {
		t.Fatalf("headers must not imply the HLS option: %s", remote)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "-user_agent ok -i https://evil.example/added.ts")
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "https://evil.example/out.ts")
	rejected := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/clip.mp4", Mode: modeVOD, Volume: 100})
	if strings.Contains(rejected, "evil.example") || strings.Contains(rejected, "-user_agent") || strings.Count(rejected, " -i ") != 1 {
		t.Fatalf("unsafe extra args must be ignored entirely: %s", rejected)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", `-user_agent "unterminated`)
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "")
	broken := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/a.m3u8", Volume: 100})
	if strings.Contains(broken, "unterminated") || !strings.Contains(broken, "-http_persistent 0") {
		t.Fatalf("a bad extra value is ignored and the default remains: %s", broken)
	}
}
