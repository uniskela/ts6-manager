// TS3 Protocol Library (ported from DreamSpeak/TSLib)

import { Ts3Client as ProtocolTs3Client } from './client.js';
import type { Ts3ClientOptions } from './client.js';
import { resolveUdpTarget } from './udp-target.js';

/**
 * Resolve the TeamSpeak UDP destination once per connection before handing the
 * connection to the protocol client. The protocol layer can then send every
 * voice packet to an IP literal instead of asking Node to resolve a hostname
 * on each dgram.send().
 */
export class Ts3Client extends ProtocolTs3Client {
  override async connect(options: Ts3ClientOptions): Promise<void> {
    const resolvedHost = await resolveUdpTarget(options.host);
    return super.connect({ ...options, host: resolvedHost });
  }
}

export type { Ts3ClientOptions } from './client.js';
export { buildCommand, parseCommand, tsEscape, tsUnescape } from './commands.js';
export type { ParsedCommand } from './commands.js';
export { eaxEncrypt, eaxDecrypt, deriveKeyNonce, hashPassword, sha1, sha256, sha512 } from './crypto.js';
export { generateIdentity, generateIdentityAsync, restoreIdentity, fromTsIdentity, fromBase64Key, exportPublicKeyString, getSharedSecret } from './identity.js';
export type { IdentityData } from './identity.js';
export { parseLicense, deriveLicenseKey, generateTemporaryKey, getSharedSecret2 } from './license.js';
export { qlzDecompress } from './quicklz.js';
