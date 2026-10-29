/** Shared audio constants. Discord and TeamSpeak Opus both run at 48 kHz with 20 ms frames. */
export const SAMPLE_RATE = 48_000;
export const FRAME_MS = 20;
/** A hole larger than two frame periods. Counted only; nothing is padded or dropped for it. */
export const ARRIVAL_GAP_MS = 40;
export const FRAME_SAMPLES = 960; // per channel
export const CHANNELS = 2;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // s16le interleaved stereo

/** Bounded jitter buffer per source: 4 frames = 80 ms. Older frames are dropped. */
export const MAX_QUEUED_FRAMES = 4;

/** TeamSpeak S2C voice codecs we accept (ReSpeak ts3protocol). */
export const TS_CODEC_OPUS_VOICE = 4;
export const TS_CODEC_OPUS_MUSIC = 5;

export const DEFAULT_SLOT_COUNT = 5;

/** Discord Opus silence frame. */
export const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
