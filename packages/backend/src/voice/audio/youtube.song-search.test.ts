import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findSongForQuery,
  parseFlatSearchOutput,
  searchYouTube,
  searchYouTubeMusic,
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

describe("searchYouTubeMusic", () => {
  it("executes the Songs search and maps actual yt-dlp stdout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ts6-song-search-"));
    const previousPath = process.env.PATH;
    try {
      const executable = path.join(directory, "yt-dlp");
      await writeFile(executable, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args.at(-2), '--');
assert.equal(args.at(-1), 'https://music.youtube.com/search?q=bohemian%20rhapsody#songs');
assert.equal(args[args.indexOf('--playlist-items') + 1], '1-1');
for (const flag of ['--flat-playlist', '--dump-json', '--no-download']) assert.ok(args.includes(flag));
console.log('[youtube:music:search_url] Downloading API JSON');
console.log(JSON.stringify({ id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artists: ['Queen'], duration: 355 }));
console.log('not json');
`);
      await chmod(executable, 0o755);
      process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
      const found = await findSongForQuery("  bohemian rhapsody  ");
      assert.equal(found?.id, "fJ9rUzIMcZQ");
      assert.equal(found?.source, "youtube-music");
      assert.equal(found?.artist, "Queen");
      assert.equal(found?.duration, 355);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("findSongForQuery", () => {
  it("rejects pre-aborted searches before calling dependencies or spawning yt-dlp", async () => {
    const signal = AbortSignal.abort();
    const unexpected = async () => { assert.fail("cancelled search must not run"); };
    await assert.rejects(findSongForQuery("song", { searchMusic: unexpected, searchVideos: unexpected }, signal), { name: "AbortError" });
    await assert.rejects(searchYouTubeMusic("song", 1, signal), { name: "AbortError" });
    await assert.rejects(searchYouTube("song", 1, signal), { name: "AbortError" });
  });

  it("propagates cancellation during Music without starting the fallback", async () => {
    const controller = new AbortController();
    await assert.rejects(findSongForQuery("song", {
      searchMusic: async (_query, signal) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        signal?.throwIfAborted();
        return [];
      },
      searchVideos: async () => { assert.fail("cancelled Music search must not fall back"); },
    }, controller.signal), { name: "AbortError" });
  });

  it("rejects late Music and fallback results after cancellation", async () => {
    for (const cancelledStage of ["music", "videos"]) {
      const controller = new AbortController();
      await assert.rejects(findSongForQuery("song", {
        searchMusic: async (_query, signal) => {
          assert.equal(signal, controller.signal);
          if (cancelledStage !== "music") return [];
          controller.abort();
          return [song("dQw4w9WgXcQ")];
        },
        searchVideos: async (_query, signal) => {
          assert.equal(cancelledStage, "videos");
          assert.equal(signal, controller.signal);
          controller.abort();
          return [song("dQw4w9WgXcQ")];
        },
      }, controller.signal), { name: "AbortError" });
    }
  });

  it("does not fall back when a dependency rejects with AbortError", async () => {
    await assert.rejects(findSongForQuery("song", {
      searchMusic: async () => { throw new DOMException("cancelled", "AbortError"); },
      searchVideos: async () => { assert.fail("aborted search must not fall back"); },
    }), { name: "AbortError" });
  });

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
