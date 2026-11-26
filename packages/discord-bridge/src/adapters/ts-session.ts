import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ClientDirectory } from "../core/client-directory.js";
import { buildCommand, generateIdentity, Ts3Client, type ParsedCommand } from "./tslib.js";

/** Transport packet types the TS3 UDP client reports for incoming voice. */
const TS_PACKET_VOICE = 0;

export interface TsSessionOptions {
  host: string;
  port: number;
  nickname: string;
  serverPassword?: string;
  /** Channel name or id. Unset means the server's default channel. */
  channel?: string;
  channelPassword?: string;
}

/**
 * One TeamSpeak connection using the existing TS3 UDP client. Emits `voice` (decrypted S2C body) for
 * channel voice only. The Bridge-K contract approves channel voice, so VoiceWhisper packets (and any
 * packet whose kind the transport did not report) are dropped and counted in `whisperDropped`.
 */
export class TsSession extends EventEmitter {
  readonly client = new Ts3Client();
  readonly directory = new ClientDirectory();
  /** Non-channel voice packets dropped at the transport boundary. */
  whisperDropped = 0;

  constructor(private readonly opts: TsSessionOptions) {
    super();
    this.client.on("voice", (data: Buffer, packetType?: number) => {
      if (packetType !== TS_PACKET_VOICE) {
        this.whisperDropped += 1;
        return;
      }
      this.emit("voice", data);
    });
    this.client.on("command", (cmd: Parameters<ClientDirectory["ingest"]>[0]) => {
      for (const ev of this.directory.ingest(cmd)) this.emit("directory", ev);
    });
    this.client.on("error", (e: Error) => this.emit("error", e));
  }

  async connect(): Promise<void> {
    await this.client.connect({
      host: this.opts.host,
      port: this.opts.port,
      identity: generateIdentity(8),
      nickname: this.opts.nickname,
      serverPassword: this.opts.serverPassword,
      defaultChannel: this.opts.channel,
      channelPassword: this.opts.channelPassword,
    });
    await this.client.ensureHomeChannelDiscovered(3000).catch(() => 0);
  }

  get clientId(): number {
    return this.client.getClientId();
  }

  get channelId(): number {
    return this.client.getCurrentChannelId();
  }

  /** Update our own nickname and wait for the correlated server reply. */
  setNickname(nickname: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.client.getState() !== "connected") return Promise.resolve(false);
    const returnCode = `presence-${randomUUID()}`;
    return new Promise((resolve) => {
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        this.client.off("command", onCommand);
        this.client.off("disconnected", cancel);
        signal.removeEventListener("abort", cancel);
        resolve(ok);
      };
      const cancel = () => settle(false);
      const onCommand = (cmd: ParsedCommand) => {
        if (cmd.name === "error" && cmd.params.return_code === returnCode) settle(cmd.params.id === "0");
      };
      const timer = setTimeout(cancel, 5_000);
      this.client.on("command", onCommand);
      this.client.once("disconnected", cancel);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.client.sendCommand(buildCommand("clientupdate", { client_nickname: nickname, return_code: returnCode }));
      } catch {
        cancel();
      }
    });
  }

  sendVoice(opus: Buffer): void {
    this.client.sendVoice(opus);
  }

  sendVoiceStop(): void {
    this.client.sendVoiceStop();
  }

  disconnect(): void {
    this.client.disconnect();
  }
}
