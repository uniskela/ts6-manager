import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSpotifyShareHostname,
  isYouTubeHostUrl,
  isYouTubeHostname,
  parseYouTubeUrl,
} from "./youtube.js";

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
  });

  it("rejects non-Spotify hosts", () => {
    assert.equal(isSpotifyShareHostname("evil.spotify.com.attacker.test"), false);
    assert.equal(isSpotifyShareHostname("spotify.com.evil.test"), false);
    assert.equal(isSpotifyShareHostname("example.com"), false);
  });

  it("accepts FQDN trailing-dot hosts", () => {
    assert.equal(isYouTubeHostname("www.youtube.com."), true);
    assert.equal(isSpotifyShareHostname("open.spotify.com."), true);
  });
});

describe("parseYouTubeUrl", () => {
  it("canonicalizes music.youtube.com to www.youtube.com", () => {
    const parsed = parseYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(parsed.videoId, "dQw4w9WgXcQ");
    assert.equal(parsed.watchUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
