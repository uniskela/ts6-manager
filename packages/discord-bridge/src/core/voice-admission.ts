/**
 * Who may be heard: the authorisation to forward a Discord user's audio into TeamSpeak.
 *
 * One instance exists per receive generation (`DiscordBot.startReceive` creates it, `stopReceive`
 * closes it), so an admission cannot outlive the generation, the connection or the bridge session it
 * was granted under. Inside it, a user holds an admission only while all of these hold:
 * - identity: Discord has said the user is a human (`HumanFilter`), and they are not one of the
 *   bridge's own identities;
 * - membership: the gateway's voice state puts them in the configured source channel now;
 * - continuity: they have not left since the admission was granted.
 *
 * Identity and membership are separate boundaries. A known human identity, however it was learned
 * (a late REST answer, discord.js's user cache), is never taken to mean the user is in the channel.
 *
 * A departure revokes the admission at once (`revoke`), and so does any check that finds the user is
 * no longer in the channel. A revoked admission never becomes valid again: a user who comes back is
 * given a new admission, and anything still queued or in flight under the old one is dropped,
 * because it carries the old token. Callers check `valid` at subscription, on every received packet,
 * and again for every queued frame immediately before it is mixed into TeamSpeak.
 *
 * Every admission of one instance is also bound to the DAVE session the receive generation started
 * under (`session`, checked by `sessionLive`). The first check that finds a different session in
 * force closes the whole instance: every admission ends for good, nothing is admitted again, and the
 * owner is told (`onSessionEnded`) so it can start a new generation, with new admissions, under the
 * new session. This is checked on every `admit` and `valid`, so it holds at the same three places,
 * whether or not anything else has noticed the replacement yet.
 */
export interface Admission {
  readonly userId: string;
  /** Unique in the process, for diagnostics. Validity is decided by identity of the object, not this number. */
  readonly id: number;
  /** The DAVE session epoch it was granted under, for diagnostics (validity is still decided by `valid`). */
  readonly session: number;
}

export interface VoiceAdmissionOptions {
  /** The configured source voice channel. */
  channelId: string;
  /** The voice channel the gateway says the user is in now; null or undefined when none or not known. */
  channelOf: (userId: string) => string | null | undefined;
  /** Identity: true only for a verified human. May start a lookup in the background. */
  isHuman: (userId: string) => boolean;
  /** The bridge's own identities, including this bot. */
  excluded: (userId: string) => boolean;
  /** Called once each time an admission is revoked (the user's streams should be closed). */
  onRevoked?: (userId: string) => void;
  /** The DAVE session epoch this receive generation started under. Default 0. */
  session?: number;
  /**
   * Is that session still the one in force on the live connection. False closes this instance for
   * good. Absent means always (tests of the admission rules alone).
   */
  sessionLive?: () => boolean;
  /** Called once, when a check finds the session replaced and closes this instance. */
  onSessionEnded?: () => void;
}

let nextAdmissionId = 1;

export class VoiceAdmission {
  private readonly current = new Map<string, Admission>();
  private closed = false;
  /** Admissions granted, and revoked (by departure, a failed re-check or close). */
  granted = 0;
  revoked = 0;
  /** True once a check found the DAVE session replaced (this instance is then closed). */
  sessionEnded = false;

  constructor(private readonly o: VoiceAdmissionOptions) {}

  /** Is this instance still open under the session it started with. A replaced session closes it here. */
  private open(): boolean {
    if (this.closed) return false;
    if (!this.o.sessionLive || this.o.sessionLive()) return true;
    this.sessionEnded = true;
    this.close();
    this.o.onSessionEnded?.();
    return false;
  }

  private present(userId: string): boolean {
    return !this.o.excluded(userId) && this.o.channelOf(userId) === this.o.channelId;
  }

  /**
   * The user's current admission, granting a new one if they are present and a verified human and
   * hold none. `null` otherwise. Membership is checked before identity, so nobody who is absent is
   * looked up.
   */
  admit(userId: string): Admission | null {
    if (!this.open()) return null;
    if (!this.present(userId)) {
      this.revoke(userId);
      return null;
    }
    if (!this.o.isHuman(userId)) return null;
    let admission = this.current.get(userId);
    if (!admission) {
      admission = Object.freeze({ userId, id: nextAdmissionId++, session: this.o.session ?? 0 });
      this.current.set(userId, admission);
      this.granted += 1;
    }
    return admission;
  }

  /**
   * Is this still the user's current admission, under the session it was granted in, and are they
   * still present. A failed presence check revokes it; a replaced session closes the instance.
   */
  valid(admission: Admission | undefined): boolean {
    if (!admission || !this.open() || this.current.get(admission.userId) !== admission) return false;
    if (!this.present(admission.userId)) {
      this.revoke(admission.userId);
      return false;
    }
    return true;
  }

  /** The user left (or is no longer present): their admission ends now and is never valid again. */
  revoke(userId: string): void {
    if (!this.current.delete(userId)) return;
    this.revoked += 1;
    this.o.onRevoked?.(userId);
  }

  /** The receive generation ended: every admission ends with it, and nothing is admitted again. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.revoked += this.current.size;
    this.current.clear();
  }

  get size(): number {
    return this.current.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
