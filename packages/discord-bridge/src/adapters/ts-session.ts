import { EventEmitter } from "node:events";
import { ClientDirectory } from "../core/client-directory.js";
import { generateIdentity, Ts3Client } from "./tslib.js";

export interface TsSessionOptions {
  host: string;
  port: number;
  nickname: string;
  serverPassword?: string;
  /** Channel name or id. Unset means the server's default channel. */
  channel?: string;
  channelPassword?: string;
}

/** One TeamSpeak connection using the existing TS3 UDP client. Emits `voice` (decrypted S2C body). */
export class TsSession extends EventEmitter {
  readonly client = new Ts3Client();
  readonly directory = new ClientDirectory();

  constructor(private readonly opts: TsSessionOptions) {
    super();
    this.client.on("voice", (data: Buffer) => this.emit("voice", data));
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
