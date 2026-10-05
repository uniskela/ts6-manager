import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSpotifyEmbedTracks, parseSpotifyPath } from "./spotify.js";

describe("parseSpotifyPath", () => {
  it("reads playlist, album and track ids, ignoring intl and embed prefixes", () => {
    assert.deepEqual(parseSpotifyPath("/playlist/37i9dQZF1DX0XUsuxWHRQd"), { kind: "playlist", id: "37i9dQZF1DX0XUsuxWHRQd" });
    assert.deepEqual(parseSpotifyPath("/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy"), { kind: "album", id: "4aawyAB9vmqN3uQ7FjRGTy" });
    assert.deepEqual(parseSpotifyPath("/embed/track/4PTG3Z6ehGkBFwjybzWkR8"), { kind: "track", id: "4PTG3Z6ehGkBFwjybzWkR8" });
  });

  it("returns other for artists, short links and malformed ids", () => {
    assert.equal(parseSpotifyPath("/artist/0TnOYISbd1XYRBk9myaseg").kind, "other");
    assert.equal(parseSpotifyPath("/abc123").kind, "other");
    assert.equal(parseSpotifyPath("/playlist/short").kind, "other");
  });
});

describe("parseSpotifyEmbedTracks", () => {
  const embed = (data: unknown) =>
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;

  it("reads the playlist name and each track's title and artists", () => {
    const html = embed({
      props: { pageProps: { state: { data: { entity: {
        type: "playlist",
        name: "RapCaviar",
        trackList: [
          { uri: "spotify:track:1", title: "FE!N", subtitle: "Travis Scott, Playboi Carti", duration: 191700 },
          { uri: "spotify:track:2", title: "  ", subtitle: "Skipped" },
          { uri: "spotify:track:3", title: "Not Like Us", subtitle: "Kendrick Lamar" },
        ],
      } } } } },
    });
    assert.deepEqual(parseSpotifyEmbedTracks(html), {
      title: "RapCaviar",
      tracks: [
        { artist: "Travis Scott, Playboi Carti", title: "FE!N" },
        { artist: "Kendrick Lamar", title: "Not Like Us" },
      ],
    });
  });

  it("returns no tracks for pages without embed data", () => {
    assert.deepEqual(parseSpotifyEmbedTracks("<html></html>"), { tracks: [] });
    assert.deepEqual(
      parseSpotifyEmbedTracks('<script id="__NEXT_DATA__" type="application/json">{oops</script>'),
      { tracks: [] },
    );
  });
});
