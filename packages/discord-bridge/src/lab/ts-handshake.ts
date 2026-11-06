/**
 * One TeamSpeak protocol handshake. Prints client/channel ids only. No Discord, no tokens.
 * Host: TS_LAB_HOST (default 127.0.0.1) TS_LAB_PORT (default 9987).
 */
import { TsSession } from "../adapters/ts-session.js";

const host = process.env.TS_LAB_HOST ?? "127.0.0.1";
const port = Number(process.env.TS_LAB_PORT ?? 9987);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("TS_LAB_PORT is not a valid port\n");
  process.exit(2);
}

const session = new TsSession({ host, port, nickname: "d1-handshake" });
session.on("error", () => undefined);
try {
  await session.connect();
  const clientId = session.clientId;
  const channelId = session.channelId;
  session.disconnect();
  if (!Number.isInteger(clientId) || clientId < 1) {
    process.stderr.write("handshake: connected but no client id\n");
    process.exit(1);
  }
  process.stdout.write(`handshake: ok clientId=${clientId} channelId=${channelId}\n`);
} catch (e) {
  session.disconnect();
  const name = e instanceof Error ? e.name : "Error";
  process.stderr.write(`handshake: fail ${name}\n`);
  process.exit(1);
}
