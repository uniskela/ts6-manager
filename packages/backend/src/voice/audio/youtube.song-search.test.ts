import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findSongForQuery,
  parseFlatSearchOutput,
  isSpotifyShareUrl,
  spotifySearchQueryFromOg,
  youTubeMusicSongSearchUrl,
  type YouTubeSearchResult,
} from "./youtube.js";

const song = (id: string, title = "Song"): YouTubeSearchResult => ({
  id, title, artist: "Artist", duration: 200, thumbnail: "",
});

describe("youTubeMusicSongSearchUrl", () => {
  it("targets the Songs section and encodes the query", () => {
    assert.equal(
      youTubeMusicSongSearchUrl("AC/DC & friends #1"),
      "https://music.youtube.com/search?q=AC%2FDC%20%26%20friends%20%231#songs",
    );
  });
});

describe("parseFlatSearchOutput", () => {
  it("maps yt-dlp Music search lines and lets findSongForQuery pick the first playable song", async () => {
    const stdout = [
      "[youtube:music:search_url] Downloading API JSON",
      JSON.stringify({ _type: "url", id: "MPREb_abcdefghijk", title: "Album result" }),
      JSON.stringify({ _type: "url", id: "fJ9rUzIMcZQ", title: "Bohemian Rhapsody", artists: ["Queen"], duration: 355 }),
      "not json",
    ].join("\n");
    const parsed = parseFlatSearchOutput(stdout);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].artist, "Queen");

    const found = await findSongForQuery("bohemian rhapsody", {
      searchMusic: async () => parsed,
      searchVideos: async () => { throw new Error("should not fall back"); },
    });
    assert.equal(found?.id, "fJ9rUzIMcZQ");
    assert.equal(found?.source, "youtube-music");
  });
});

describe("findSongForQuery", () => {
  it("prefers the top YouTube Music song", async () => {
    const found = await findSongForQuery("  thunderstruck ", {
      searchMusic: async (q) => { assert.equal(q, "thunderstruck"); return [song("v2AC41dglnM", "Thunderstruck")]; },
      searchVideos: async () => { throw new Error("should not search videos"); },
    });
    assert.equal(found?.source, "youtube-music");
    assert.equal(found?.url, "https://www.youtube.com/watch?v=v2AC41dglnM");
    assert.equal(found?.title, "Thunderstruck");
  });

  it("falls back to YouTube search when Music is empty or fails", async () => {
    for (const searchMusic of [async () => [], async () => { throw new Error("boom"); }]) {
      const found = await findSongForQuery("q", {
        searchMusic,
        searchVideos: async () => [song("dQw4w9WgXcQ")],
      });
      assert.equal(found?.source, "youtube");
      assert.equal(found?.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
  });

  it("skips non-video entries and returns null when nothing matches", async () => {
    const found = await findSongForQuery("q", {
      searchMusic: async () => [song("UCabcdefghijklmnopqrstuv"), song("dQw4w9WgXcQ")],
      searchVideos: async () => [],
    });
    assert.equal(found?.id, "dQw4w9WgXcQ");
    assert.equal(
      await findSongForQuery("q", { searchMusic: async () => [], searchVideos: async () => [] }),
      null,
    );
    assert.equal(await findSongForQuery("   "), null);
  });
});

describe("isSpotifyShareUrl", () => {
  it("matches Spotify share hosts only", () => {
    assert.equal(isSpotifyShareUrl("https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8"), true);
    assert.equal(isSpotifyShareUrl("https://spotify.link/abc"), true);
    assert.equal(isSpotifyShareUrl("https://open.spotify.com./track/x"), true);
    assert.equal(isSpotifyShareUrl("https://notspotify.com/track/x"), false);
    assert.equal(isSpotifyShareUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), false);
    assert.equal(isSpotifyShareUrl("not a url"), false);
  });
});

describe("spotifySearchQueryFromOg", () => {
  it("matches Open Graph attributes with other attributes in between, in either order", () => {
    const html =
      '<meta property="og:title" data-rh="true" content="Never Gonna Give You Up"/>' +
      '<meta content="Rick Astley · Song · 1987" data-rh="true" property="og:description"/>';
    assert.equal(spotifySearchQueryFromOg(html), "Rick Astley Never Gonna Give You Up");
  });

  it("adds the artist for track pages", () => {
    const html =
      '<meta property="og:title" content="Never Gonna Give You Up"/>' +
      '<meta property="og:description" content="Rick Astley · Song · 1987"/>';
    assert.equal(spotifySearchQueryFromOg(html), "Rick Astley Never Gonna Give You Up");
  });

  it("uses the title alone for albums and playlists, and decodes entities", () => {
    const html =
      '<meta content="Rock &amp; Roll" property="og:title"/>' +
      '<meta property="og:description" content="Various · album · 2001 · 12 songs."/>';
    assert.equal(spotifySearchQueryFromOg(html), "Rock & Roll");
  });

  it("returns empty when the page has no title", () => {
    assert.equal(spotifySearchQueryFromOg("<html></html>"), "");
  });
});
