# AV1 decoder diagnostic fixtures

These are representative fixtures reconstructed from official FFmpeg source,
not captured hardware runs. Pointer values and error strings are illustrative.
The selected AV1 video is input 0, stream 1 (audio precedes video).

Verified tags: `n5.1`, `n6.1`, `n7.0`, `n8.0`, `n9.0.1` at
https://github.com/FFmpeg/FFmpeg .

- 5.1: `fftools/ffmpeg.c`, `process_input_packet`, line 2465:
  `Error while decoding stream #%d:%d: %s`.
- 6.1: `fftools/ffmpeg_dec.c`, `decode`, lines 574 and 602:
  `Error submitting %s to decoder: %s` and `Decoding error: %s`.
  `fftools/ffmpeg_demux.c` line 1026 names the parent `%cist#%d:%d/%s`.
- 7.0: `ffmpeg_dec.c` lines 688, 715; decoder context `dec:%s`
  line 1157, parent from `ffmpeg_demux.c` line 940.
- 8.0: `ffmpeg_dec.c` lines 733, 760; context line 1537.
- 9.0.1: `ffmpeg_dec.c` lines 728, 758; context line 1536.

The parser deliberately excludes generic `Error processing packet in decoder`
(which can wrap downstream/filter errors), EOF submission, audio contexts,
other inputs/codecs, and network/demux errors. A selected video decode error
is evidence, not proof of GPU incompatibility: corrupt AV1 input can produce
the same error. The single software retry therefore needs one such error
before a failed exit, or `av1SustainedDecodeErrors` of them from an ffmpeg
that runs on. Unscoped libavcodec diagnostics
alone cannot safely identify the selected video and are not matched.

`ffmpeg-7.0.2-runtime.log` is an actual Linux CPU-only runtime capture using
FFmpeg 7.0.2-static (johnvansickle.com build). The embedded AV1 sample was
remuxed with PCM audio as stream 0 and copied AV1 video as stream 1:

```sh
ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -i av1_probe.ivf \
  -map 0:a -map 1:v -c:a pcm_s16le -c:v copy -t 0.2 reordered.mkv
ffmpeg -hide_banner -nostdin -loglevel error -c:v av1 \
  -i reordered.mkv -f null -
```

Native AV1 failed (exit 69) as expected without GPU acceleration; its scoped
packet-submission diagnostic matches the source-derived fixture. This checks
runtime diagnostic formatting and stream attribution, not any GPU capability.
