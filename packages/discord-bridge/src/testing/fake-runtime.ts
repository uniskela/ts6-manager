import { EventEmitter } from "node:events";
import type { BotPort, NickResult } from "../bridge/runtime.js";
import { ClientDirectory } from "../core/client-directory.js";
import type { BotId } from "../core/ids.js";

/** A Discord bot as the runtime sees it, with switches for the failures the runtime must survive. */
export class FakeBot extends EventEmitter implements BotPort {
  healthy = false;
  deaf = true;
  inVoice = false;
  receiving: number | null = null;
  nick: string | null = null;
  sent: Buffer[] = [];
  log: string[] = [];
  joinCount = 0;
  /** While set, `join` waits for it (a reconnect that hangs). `leave()` aborts the wait. */
  gate: Promise<void> | null = null;
  failJoin: Error | null = null;
  /** Mimic a bot that reports its own intentional leave as a failure (the baseline behaviour). */
  emitUnhealthyOnLeave = false;
  nickCalls: (string | null)[] = [];
  nickDelay: Promise<void> | null = null;
  nickFailRemaining = 0;
  nickDenied = false;
  private abortJoin: (() => void) | null = null;

  constructor(readonly id: BotId, readonly userId: string, private readonly order?: string[]) {
    super();
  }

  /** Make the next joins hang until `release()`. */
  hang(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((r) => (release = r));
    return () => {
      this.gate = null;
      release();
    };
  }

  async join(o: { receive: boolean }): Promise<void> {
    this.joinCount += 1;
    this.log.push(`join(receive=${o.receive})`);
    this.order?.push(`${this.id}.join`);
    if (this.failJoin) throw this.failJoin;
    if (this.gate) {
      const aborted = new Promise<never>((_, reject) => (this.abortJoin = () => reject(new Error("join aborted"))));
      await Promise.race([this.gate, aborted]);
    }
    this.inVoice = true;
    this.healthy = true;
    this.deaf = !o.receive;
  }

  leave(): void {
    this.abortJoin?.();
    this.inVoice = false;
    this.healthy = false;
    this.receiving = null;
    this.log.push("leave");
    this.order?.push(`${this.id}.leave`);
    if (this.emitUnhealthyOnLeave) queueMicrotask(() => this.emit("unhealthy", "voice destroyed"));
  }

  async setNickname(n: string | null): Promise<NickResult> {
    this.nickCalls.push(n);
    if (this.nickDelay) await this.nickDelay;
    if (this.nickDenied) return "denied";
    if (this.nickFailRemaining > 0) {
      this.nickFailRemaining -= 1;
      return "failed";
    }
    this.nick = n;
    return "ok";
  }

  startReceive(g: number): boolean {
    this.receiving = g;
    this.log.push(`startReceive(${g})`);
    this.order?.push(`${this.id}.startReceive`);
    return true;
  }

  stopReceive(): void {
    this.receiving = null;
    this.log.push("stopReceive");
  }

  sendOpus(f: Buffer): void {
    this.sent.push(f);
  }

  endSpeech(): void {}

  /** Simulates the Discord connection dying. */
  die(): void {
    this.healthy = false;
    this.inVoice = false;
    this.receiving = null;
    this.emit("unhealthy", "connection lost");
  }
}

export class FakeTs extends EventEmitter {
  directory = new ClientDirectory();
  clientId = 1;
  channelId = 1;
  out: Buffer[] = [];
  stops = 0;
  sendVoice(o: Buffer): void {
    this.out.push(o);
  }
  sendVoiceStop(): void {
    this.stops++;
  }
  addUser(n: number, name = `User${n}`): void {
    const params = { ctid: "1", clid: String(100 + n), client_unique_identifier: `uid${n}`, client_nickname: name };
    for (const ev of this.directory.ingest({ name: "notifycliententerview", params })) this.emit("directory", ev);
  }
  removeUser(n: number): void {
    for (const ev of this.directory.ingest({ name: "notifyclientleftview", params: { clid: String(100 + n) } })) this.emit("directory", ev);
  }
  renameUser(n: number, name: string): void {
    for (const ev of this.directory.ingest({
      name: "notifyclientupdated",
      params: { clid: String(100 + n), client_nickname: name },
    })) {
      this.emit("directory", ev);
    }
  }
}

/**
 * Wait until the runtime has nothing left to do. Uses `idle()` when the runtime has it and falls
 * back to flushing the queue twice, so the same tests also run against the reviewed baseline.
 */
export async function settle(rt: { enqueue(fn: () => Promise<void>): Promise<void>; idle?: () => Promise<void> }): Promise<void> {
  if (rt.idle) return rt.idle();
  await rt.enqueue(async () => undefined);
  await rt.enqueue(async () => undefined);
}
