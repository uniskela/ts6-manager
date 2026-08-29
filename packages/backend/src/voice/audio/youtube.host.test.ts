import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCookieArgs,
  isSpotifyShareHostname,
  isYouTubeHostUrl,
  isYouTubeHostname,
  mapYtDlpInfoJson,
  parseYouTubeUrl,
  resolveSpotifyFetchHost,
} from "./youtube.js";

describe("getCookieArgs", () => {
  it("includes YouTube extractor resilience args", () => {
    const args = getCookieArgs();
    assert.ok(args.includes("--extractor-args"));
    assert.ok(args.some((a) => a.includes("player_client")));
  });
});

describe("isYouTubeHostname", () => {
  it("accepts real YouTube hosts", () => {
    assert.equal(isYouTubeHostname("youtube.com"), true);
    assert.equal(isYouTubeHostname("www.youtube.com"), true);
    assert.equal(isYouTubeHostname("m.youtube.com"), true);
    assert.equal(isYouTubeHostname("music.youtube.com"), true);
    assert.equal(isYouTubeHostname("youtu.be"), true);
  });

  it("rejects substring lookalikes", () => {
    assert.equal(isYouTubeHostname("evil-youtube.com"), false);
    assert.equal(isYouTubeHostname("youtube.com.evil.example"), false);
    assert.equal(isYouTubeHostname("notyoutube.com"), false);
  });
});

describe("isYouTubeHostUrl", () => {
  it("parses URLs with the same host rules", () => {
    assert.equal(isYouTubeHostUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
    assert.equal(isYouTubeHostUrl("https://evil-youtube.com/watch?v=dQw4w9WgXcQ"), false);
  });
});

describe("isSpotifyShareHostname", () => {
  it("accepts Spotify share hosts", () => {
    assert.equal(isSpotifyShareHostname("open.spotify.com"), true);
    assert.equal(isSpotifyShareHostname("spotify.link"), true);
    assert.equal(isSpotifyShareHostname("spotify.com"), true);
    assert.equal(isSpotifyShareHostname("play.spotify.com"), true);
  });

  it("rejects non-Spotify and non-allowlisted hosts", () => {
    assert.equal(isSpotifyShareHostname("evil.spotify.com.attacker.test"), false);
    assert.equal(isSpotifyShareHostname("spotify.com.evil.test"), false);
    assert.equal(isSpotifyShareHostname("example.com"), false);
    assert.equal(isSpotifyShareHostname("accounts.spotify.com"), false);
  });

  it("accepts FQDN trailing-dot hosts via normalization", () => {
    assert.equal(isYouTubeHostname("www.youtube.com."), true);
    assert.equal(isSpotifyShareHostname("open.spotify.com."), true);
  });

  it("resolveSpotifyFetchHost returns constant allowlisted hosts", () => {
    assert.equal(resolveSpotifyFetchHost("OPEN.SPOTIFY.COM."), "open.spotify.com");
    assert.equal(resolveSpotifyFetchHost("evil.com"), null);
  });
});

describe("parseYouTubeUrl", () => {
  it("canonicalizes music.youtube.com to www.youtube.com", () => {
    const parsed = parseYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(parsed.videoId, "dQw4w9WgXcQ");
    assert.equal(parsed.watchUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

describe("mapYtDlpInfoJson", () => {
  it("does not throw when dump-single-json is literal null", () => {
    const mapped = mapYtDlpInfoJson("null", "dQw4w9WgXcQ");
    assert.ok(mapped);
    assert.equal(mapped!.items[0].id, "dQw4w9WgXcQ");
  });

  it("handles entries: null without TypeError", () => {
    const mapped = mapYtDlpInfoJson(JSON.stringify({ id: "abc12345678", title: "T", entries: null }));
    assert.ok(mapped);
    assert.equal(mapped!.type, "video");
    assert.equal(mapped!.items[0].id, "abc12345678");
  });

  it("maps playlist entries", () => {
    const mapped = mapYtDlpInfoJson(JSON.stringify({
      title: "Mix",
      entries: [{ id: "aaaaaaaaaaa", title: "A" }, { id: "bbbbbbbbbbb", title: "B" }, null],
    }));
    assert.ok(mapped);
    assert.equal(mapped!.type, "playlist");
    assert.equal(mapped!.items.length, 2);
  });
});
