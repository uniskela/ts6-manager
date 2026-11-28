/**
 * Process-lifetime totals per DiscordBot, reset on construction only. Rejoins, connection
 * replacement, DAVE changes, leave and destroy preserve them. Existing framesSent counts feed offers.
 *
 * | Field | Observation (units are frames/packets unless noted) |
 * | --- | --- |
 * | consumed | Non-null player reads of a FrameFeed, excluding overflow and destroyed-stream cleanup. |
 * | preparedAudio / preparedSilence | Guarded prepare returned a packet, split by input silence. |
 * | prepareRefusedAudio / prepareRefusedSilence | Guarded prepare returned undefined, split by input silence. |
 * | sentAudio / sentSilence | Guarded dispatch returned true for the corresponding pending packet. |
 * | dispatchFenced | A guarded dispatch returned false for a pending packet. |
 * | dispatchUnconfirmed | Dispatch of a pending packet threw or returned no boolean result. |
 * | abandoned | An undispatched preparation was superseded by a later prepare result, or its transport was retired. |
 * | pending | Prepared packets without a terminal outcome yet, including while dispatch is on the stack. |
 * | lastAudioSentAgeMs | Milliseconds since the last sentAudio increment, or null if never sent. |
 * | connectionErrors | Voice connection error events, counted without capturing the error. |
 *
 * Each successful preparation contributes exactly once to sentAudio + sentSilence + dispatchFenced +
 * dispatchUnconfirmed + abandoned + pending. Dispatch without a pending packet adds no outcome.
 * At normal player/status boundaries pending is zero or one. The final padding packet can remain
 * pending while idle. A transport resume may keep it, too.
 *
 * "Sent" means handed to the local UDP socket. The library calls socket.send without a completion
 * callback. This does not prove successful asynchronous submission, that the packet left the host,
 * reached Discord, or was decrypted or heard by anyone.
 */
export interface OutboundTelemetry {
  readonly consumed: number;
  readonly preparedAudio: number;
  readonly preparedSilence: number;
  readonly prepareRefusedAudio: number;
  readonly prepareRefusedSilence: number;
  readonly sentAudio: number;
  readonly sentSilence: number;
  readonly dispatchFenced: number;
  readonly dispatchUnconfirmed: number;
  readonly abandoned: number;
  readonly pending: number;
  readonly lastAudioSentAgeMs: number | null;
  readonly connectionErrors: number;
}

const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

export function isOutboundSilence(frame: Buffer): boolean {
  return frame.length === SILENCE_FRAME.length && frame.equals(SILENCE_FRAME);
}

export function outboundCounters() {
  return {
    preparedAudio: 0,
    preparedSilence: 0,
    prepareRefusedAudio: 0,
    prepareRefusedSilence: 0,
    sentAudio: 0,
    sentSilence: 0,
    dispatchFenced: 0,
    dispatchUnconfirmed: 0,
    abandoned: 0,
    pending: 0,
    lastAudioSentAt: null as number | null,
    connectionErrors: 0,
  };
}

/** One guarded connection's attribution. Keep only the packet kind, never the packet. */
export function trackOutboundConnection(counters: ReturnType<typeof outboundCounters>, now: () => number) {
  let pending: "audio" | "silence" | null = null;
  let revision = 0;

  function abandonPending(): void {
    if (pending === null) return;
    pending = null;
    counters.pending -= 1;
    counters.abandoned += 1;
  }

  return {
    get revision() { return revision; },
    invalidate() {
      revision += 1;
      abandonPending();
    },
    prepare(silence: boolean, prepared: boolean, startedAtRevision: number) {
      const current = startedAtRevision === revision;
      // Even a refused prepare clears the guard's epoch, making the previous packet unusable.
      if (current) abandonPending();
      if (!prepared) {
        counters[silence ? "prepareRefusedSilence" : "prepareRefusedAudio"] += 1;
        return;
      }
      counters[silence ? "preparedSilence" : "preparedAudio"] += 1;
      if (!current) {
        counters.abandoned += 1;
        return;
      }
      pending = silence ? "silence" : "audio";
      counters.pending += 1;
    },
    dispatch(inner: () => boolean | undefined): boolean | undefined {
      // The guard uses the preparation once. An invalidation inside dispatch must not also settle it.
      // The gauge still includes this packet until the inner call finishes.
      const packet = pending;
      pending = null;
      let result: boolean | undefined;
      try {
        result = inner();
        return result;
      } finally {
        if (packet !== null) {
          counters.pending -= 1;
          if (result === true) {
            if (packet === "silence") counters.sentSilence += 1;
            else {
              counters.sentAudio += 1;
              counters.lastAudioSentAt = now();
            }
          } else if (result === false) counters.dispatchFenced += 1;
          else counters.dispatchUnconfirmed += 1;
        }
      }
    },
  };
}
