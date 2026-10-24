import { TS_CODEC_OPUS_MUSIC, TS_CODEC_OPUS_VOICE } from "./constants.js";

export interface TsVoicePacket {
  voiceId: number;
  /** Speaker client id on the TeamSpeak server (not the uniqueId). */
  clid: number;
  codec: number;
  /** Opus payload. Empty means end-of-voice for that speaker. */
  opus: Buffer;
}

/**
 * Parse the decrypted body of an S2C Voice packet: VId u16, speaker CId u16, codec u8, Opus.
 * Returns null for anything malformed or for codecs the bridge does not carry.
 * D1 note: the existing client emits Voice and VoiceWhisper through the same event, so a
 * whisper cannot be told apart here. That is a recorded D2 requirement.
 */
export function parseS2CVoice(data: Buffer): TsVoicePacket | null {
  if (data.length < 5) return null;
  const codec = data[4];
  if (codec !== TS_CODEC_OPUS_VOICE && codec !== TS_CODEC_OPUS_MUSIC) return null;
  return {
    voiceId: data.readUInt16BE(0),
    clid: data.readUInt16BE(2),
    codec,
    opus: data.subarray(5),
  };
}
