import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSongForQuery, youTubeMusicSongSearchUrl, type YouTubeSearchResult } from "./youtube.js";

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
