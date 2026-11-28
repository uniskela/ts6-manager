import type { TsSession } from "../adapters/ts-session.js";

export const BETA_TS_NICKNAME = "ts6-bridge-d1-beta";

/** One serialized display update at a time, outside the audio and membership queues. */
export function startListenerPresence(ts: TsSession, readCount: () => number, warn: (line: string) => void): () => void {
  const home = ts.channelId;
  const stop = new AbortController();
  let applied: number | null = 0;
  let pending = false;
  let retryAt = 0;

  const update = async () => {
    if (stop.signal.aborted || pending || Date.now() < retryAt || !ts.clientId) return;
    const count = home > 0 && ts.channelId === home ? readCount() : 0;
    if (count === applied) return;
    pending = true;
    const nickname = count > 0 ? `[DC] ${count} in voice` : BETA_TS_NICKNAME;
    const accepted = await ts.setNickname(nickname, stop.signal);
    pending = false;
    if (stop.signal.aborted) return;
    applied = accepted ? count : null;
    if (!accepted) {
      retryAt = Date.now() + 30_000;
      warn("TeamSpeak listener presence nickname update unconfirmed; retrying after hold");
    }
  };

  const timer = setInterval(() => void update(), 2_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    stop.abort();
  };
}
