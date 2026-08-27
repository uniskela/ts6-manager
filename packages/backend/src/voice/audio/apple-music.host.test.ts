import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractTracksFromSerializedServerData,
  isAppleMusicShareHostname,
  isAppleMusicShareUrl,
  parseAppleMusicUrl,
  resolveAppleMusicFetchHost,
} from "./apple-music.js";

describe("isAppleMusicShareHostname", () => {
  it("accepts Apple Music / iTunes share hosts", () => {
    assert.equal(isAppleMusicShareHostname("music.apple.com"), true);
    assert.equal(isAppleMusicShareHostname("itunes.apple.com"), true);
    assert.equal(isAppleMusicShareHostname("geo.itunes.apple.com"), true);
    assert.equal(isAppleMusicShareHostname("apple.co"), true);
  });

  it("rejects non-allowlisted hosts", () => {
    assert.equal(isAppleMusicShareHostname("evil.music.apple.com"), false);
    assert.equal(isAppleMusicShareHostname("music.apple.com.evil.test"), false);
    assert.equal(isAppleMusicShareHostname("example.com"), false);
    assert.equal(isAppleMusicShareHostname("apple.com"), false);
  });

  it("resolveAppleMusicFetchHost returns constant allowlisted hosts", () => {
    assert.equal(resolveAppleMusicFetchHost("MUSIC.APPLE.COM."), "music.apple.com");
    assert.equal(resolveAppleMusicFetchHost("evil.com"), null);
  });
});

describe("isAppleMusicShareUrl", () => {
  it("parses URLs with the same host rules", () => {
    assert.equal(
      isAppleMusicShareUrl("https://music.apple.com/us/album/foo/1440857781?i=1440857881"),
      true,
    );
    assert.equal(isAppleMusicShareUrl("https://evil.music.apple.com/us/song/x/1"), false);
  });
});

describe("parseAppleMusicUrl", () => {
  it("parses album song (?i=) as song", () => {
    const p = parseAppleMusicUrl(
      "https://music.apple.com/us/album/in-between-dreams/1440857781?i=1440857881",
    );
    assert.equal(p.kind, "song");
    assert.equal(p.id, "1440857781");
    assert.equal(p.songId, "1440857881");
    assert.equal(p.storefront, "us");
  });

  it("parses album without i= as album", () => {
    const p = parseAppleMusicUrl("https://music.apple.com/us/album/in-between-dreams/1440857781");
    assert.equal(p.kind, "album");
    assert.equal(p.id, "1440857781");
  });

  it("parses playlist pl.* ids", () => {
    const p = parseAppleMusicUrl(
      "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
    );
    assert.equal(p.kind, "playlist");
    assert.equal(p.id, "pl.f4d106fed2bd41149aaacabb233eb5eb");
  });

  it("parses /song/ paths", () => {
    const p = parseAppleMusicUrl("https://music.apple.com/us/song/better-together/1440857881");
    assert.equal(p.kind, "song");
    assert.equal(p.songId, "1440857881");
  });
});

describe("extractTracksFromSerializedServerData", () => {
  it("extracts track-lockup rows and playlist header title", () => {
    const data = {
      data: [
        {
          data: {
            sections: [
              {
                items: [
                  {
                    id: "playlist-detail-header - pl.abc",
                    title: "Today's Hits",
                    subtitle: "Apple Music Hits",
                  },
                ],
              },
              {
                items: [
                  {
                    id: "track-lockup - pl.abc - 1",
                    title: "Song One",
                    artistName: "Artist A",
                  },
                  {
                    id: "track-lockup - pl.abc - 2",
                    title: "Song Two",
                    subtitle: "Artist B",
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const extracted = extractTracksFromSerializedServerData(data);
    assert.equal(extracted.title, "Today's Hits");
    assert.deepEqual(extracted.tracks, [
      { artist: "Artist A", title: "Song One" },
      { artist: "Artist B", title: "Song Two" },
    ]);
  });
});
