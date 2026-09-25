import { EventEmitter } from 'events';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { SshQueryClient, formatFatalSshFailureMessage } from './ssh-query-client.js';
import { decrypt } from '../utils/crypto.js';
import { sanitizeTsServerHost, validateTsServerPort } from '../utils/validate-ts-host.js';
import { ClientMetadataCache } from './client-metadata-cache.js';

/** Explicit multi-consumer ownership of main EventBridge SSH sessions. */
export type SessionOwnerKind = 'flow' | 'music' | 'journal';

export declare interface EventBridge {
  on(event: 'tsEvent', listener: (configId: number, sid: number, eventName: string, data: Record<string, string>) => void): this;
  on(event: 'sshConnected', listener: (configId: number, sid: number) => void): this;
  on(event: 'sshDisconnected', listener: (configId: number, sid: number) => void): this;
  on(event: 'sshError', listener: (configId: number, sid: number, err: Error) => void): this;
  emit(event: 'tsEvent', configId: number, sid: number, eventName: string, data: Record<string, string>): boolean;
  emit(event: 'sshConnected', configId: number, sid: number): boolean;
  emit(event: 'sshDisconnected', configId: number, sid: number): boolean;
  emit(event: 'sshError', configId: number, sid: number, err: Error): boolean;
}

export class EventBridge extends EventEmitter {
  private connections: Map<string, SshQueryClient> = new Map();
  /** Reserve a pair before the async database lookup can start another SSH login. */
  private connecting = new Map<string, Promise<void>>();
  private registered = new Set<string>();
  /** Channel the main SSH Query client currently occupies for music text (roaming helper). */
  private mainHelperChannel = new Map<string, number>();
  /**
   * Last known park target retained across SSH close/reconnect so we can remount
   * after `registerEvents` (`use sid=` drops Query back to the default channel).
   */
  private mainHelperRemountAfterReconnect = new Map<string, number>();
  /** Serialize helper moves / sends on the main SSH to avoid Query floods. */
  private mainHelperChain: Promise<void> = Promise.resolve();
  /** Who is keeping each main SSH session alive (flows / music / journal). */
  private sessionOwners = new Map<string, Set<SessionOwnerKind>>();
  /**
   * Permanent connect failures (auth / host-key) after the client was removed.
   * Preserved so executeCommand can surface a non-retryable error instead of
   * generic "SSH not connected" (which Files maps to reconnectable 503).
   */
  private fatalSshFailures = new Map<string, string>();
  /** Shared leave/join identity enrichment (#74) — one boundary for flows + journal. */
  readonly clientCache = new ClientMetadataCache();

  constructor(private prisma: PrismaClient) {
    super();
  }

  private makeKey(configId: number, sid: number): string {
    return `${configId}:${sid}`;
  }

  /**
   * Drop the trusted helper-channel cache for a config:sid pair.
   * After SSH close / `use sid=`, Query is no longer in the cached channel — keeping
   * the cache would make `moveMainHelperToChannel` skip remount and attribute chat wrong.
   */
  private forgetMainHelperLocation(key: string, opts?: { retainRemountTarget?: boolean }): void {
    const last = this.mainHelperChannel.get(key) || 0;
    this.mainHelperChannel.delete(key);
    if (opts?.retainRemountTarget !== false && last > 0) {
      this.mainHelperRemountAfterReconnect.set(key, last);
    }
  }

  private async remountMainHelperAfterReconnect(configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    // Snapshot only to know whether a remount is worth enqueueing. Do **not**
    // delete the park target here — a concurrent `ensureHelperInChannel` may
    // park elsewhere first; deleting early would also prevent retry on failure.
    if ((this.mainHelperRemountAfterReconnect.get(key) || 0) <= 0) return;
    await this.enqueueMainHelperWork(async () => {
      // Re-read under the helper lock: a newer park may have cleared or replaced
      // the target while we were queued. Follow the latest target, or no-op.
      const parkCid = this.mainHelperRemountAfterReconnect.get(key) || 0;
      if (parkCid <= 0) {
        return;
      }
      const ok = await this.moveMainHelperToChannel(configId, sid, parkCid);
      if (ok) {
        // moveMainHelperToChannel clears the remount target on success.
        console.log(
          `[EventBridge] Remounted main SSH helper in cid=${parkCid} for ${key} after reconnect`,
        );
      }
      // On failure leave mainHelperRemountAfterReconnect so a later retry can remount.
    });
  }

  private buildSshOptions(serverConfig: {
    id: number;
    host: string;
    sshPort: number;
    sshUsername: string;
    sshPassword: string;
    sshHostKeyFingerprint: string | null;
  }) {
    return {
      host: sanitizeTsServerHost(serverConfig.host),
      port: validateTsServerPort(serverConfig.sshPort, 10022),
      username: serverConfig.sshUsername,
      password: decrypt(serverConfig.sshPassword),
      hostKeyFingerprint: serverConfig.sshHostKeyFingerprint,
      onHostKeyPinned: async (fingerprint: string) => {
        await this.prisma.tsServerConfig.update({
          where: { id: serverConfig.id },
          data: { sshHostKeyFingerprint: fingerprint },
        });
        console.log(`[EventBridge] Pinned SSH host key for config ${serverConfig.id}: ${fingerprint}`);
      },
    };
  }

  async connectServer(configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    const pending = this.connecting.get(key);
    if (pending) return pending;
    if (this.connections.has(key)) return;

    const attempt = this.startServerConnection(configId, sid);
    this.connecting.set(key, attempt);
    try {
      await attempt;
    } finally {
      if (this.connecting.get(key) === attempt) this.connecting.delete(key);
    }
  }

  private async startServerConnection(configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);

    const serverConfig = await this.prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });

    if (!serverConfig) {
      console.warn(`[EventBridge] Server config ${configId} not found`);
      return;
    }

    if (!serverConfig.sshUsername || !serverConfig.sshPassword || !serverConfig.sshPort) {
      console.warn(`[EventBridge] Server config ${configId} has no SSH credentials, skipping SSH connection`);
      return;
    }

    const client = new SshQueryClient(this.buildSshOptions({
      id: serverConfig.id,
      host: serverConfig.host,
      sshPort: serverConfig.sshPort,
      sshUsername: serverConfig.sshUsername,
      sshPassword: serverConfig.sshPassword,
      sshHostKeyFingerprint: serverConfig.sshHostKeyFingerprint,
    }));

    client.on('ready', async () => {
      console.log(`[EventBridge] SSH connected to ${serverConfig.host}:${serverConfig.sshPort} for sid=${sid}`);
      try {
        // New connection generation: clids from a prior SSH session must not enrich leaves.
        this.clientCache.beginGeneration(configId, sid);
        await client.registerEvents(sid);
        if (this.connections.get(key) !== client || !client.isConnected) return;
        this.registered.add(key);
        // Seed identity cache from current clients (does not manufacture journal joins).
        await this.seedClientIdentityCache(configId, sid, client);
        // `use sid=` parks Query in the default channel — remount if we had a helper park.
        try {
          await this.remountMainHelperAfterReconnect(configId, sid);
        } catch (remountErr: any) {
          console.warn(
            `[EventBridge] Helper remount after reconnect failed for ${key}: ${remountErr.message}`,
          );
        }
        this.emit('sshConnected', configId, sid);
      } catch (err: any) {
        console.error(`[EventBridge] Failed to register events for ${key}: ${err.message}`);
      }
    });

    client.on('event', (eventName: string, data: Record<string, string>) => {
      const enriched = this.clientCache.enrich(configId, sid, eventName, data);
      this.emit('tsEvent', configId, sid, eventName, enriched);
    });

    client.on('error', (err: Error) => {
      console.error(`[EventBridge] SSH error for ${key}: ${err.message}`);
      this.emit('sshError', configId, sid, err);
    });

    client.on('close', () => {
      console.log(`[EventBridge] SSH disconnected for ${key}`);
      this.registered.delete(key);
      this.clientCache.clearPair(configId, sid);
      // Cache is stale: Query will land in default channel on next registerEvents.
      this.forgetMainHelperLocation(key);
      this.emit('sshDisconnected', configId, sid);
    });

    this.connections.set(key, client);
    // New attempt — drop stale fatal marker until this connect proves permanent failure.
    this.fatalSshFailures.delete(key);

    try {
      await client.connect();
    } catch (err: any) {
      console.error(`[EventBridge] Initial SSH connection failed for ${key}: ${err.message}`);
      // Auto-reconnect is handled internally by SshQueryClient (unless fatal)
      if (client.hasFatalError) {
        const detail = client.lastFatalError || err.message || 'SSH authentication failed';
        this.fatalSshFailures.set(key, detail);
        this.forgetMainHelperLocation(key, { retainRemountTarget: false });
        this.mainHelperRemountAfterReconnect.delete(key);
        this.connections.delete(key);
      }
    }
  }

  async disconnectServer(configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    // A connection still looking up its config must not materialize after disconnect.
    const pending = this.connecting.get(key);
    if (pending) await pending;
    const client = this.connections.get(key);
    this.registered.delete(key);
    this.clientCache.clearPair(configId, sid);
    this.fatalSshFailures.delete(key);
    // Clear trusted location before destroy; retain remount target so reconnectConfig
    // (and SSH auto-reconnect) can park again after registerEvents.
    this.forgetMainHelperLocation(key);
    if (client) {
      await client.destroy();
      this.connections.delete(key);
    }
  }

  /**
   * Retain the main SSH session for a consumer. Connects on demand.
   * Releasing the last owner disconnects the session.
   */
  async retainSession(owner: SessionOwnerKind, configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    let owners = this.sessionOwners.get(key);
    if (!owners) {
      owners = new Set();
      this.sessionOwners.set(key, owners);
    }
    owners.add(owner);
    await this.connectServer(configId, sid);
  }

  async releaseSession(owner: SessionOwnerKind, configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    const owners = this.sessionOwners.get(key);
    if (!owners) return;
    owners.delete(owner);
    if (owners.size === 0) {
      this.sessionOwners.delete(key);
      await this.disconnectServer(configId, sid);
    }
  }

  getSessionOwners(configId: number, sid: number): SessionOwnerKind[] {
    const owners = this.sessionOwners.get(this.makeKey(configId, sid));
    return owners ? Array.from(owners) : [];
  }

  hasSessionOwner(configId: number, sid: number, owner: SessionOwnerKind): boolean {
    return this.sessionOwners.get(this.makeKey(configId, sid))?.has(owner) ?? false;
  }

  getClientCacheGeneration(configId: number, sid: number): number {
    return this.clientCache.getGeneration(configId, sid);
  }

  private async seedClientIdentityCache(
    configId: number,
    sid: number,
    client: SshQueryClient,
  ): Promise<void> {
    try {
      const { parseQueryResponse } = await import('@ts6/common');
      await client.executeCommand(`use sid=${sid}`);
      const raw = await client.executeCommand('clientlist -uid');
      const rows = parseQueryResponse(raw.trim()) as Record<string, string>[];
      const clids = this.clientCache.seedFromClientList(configId, sid, rows);
      console.log(
        `[EventBridge] Seeded ${clids.length} client identity cache entr${clids.length === 1 ? 'y' : 'ies'} for ${configId}:${sid}`,
      );
    } catch (err: any) {
      console.warn(
        `[EventBridge] clientlist seed failed for ${configId}:${sid}: ${err.message}`,
      );
    }
  }

  /**
   * Drop all SSH connections (and command listeners) for a server config, then
   * reconnect any that were previously active so updated credentials take effect.
   */
  async reconnectConfig(configId: number): Promise<void> {
    const prefix = `${configId}:`;
    const sidsToReconnect: number[] = [];
    const cmdListenersToRestore: Array<{ sid: number; channelId: number }> = [];

    for (const key of [...this.connections.keys()]) {
      if (!key.startsWith(prefix)) continue;
      // Skip cmd listener keys if they ever share the map (they don't)
      const sid = parseInt(key.slice(prefix.length), 10);
      if (!Number.isNaN(sid)) sidsToReconnect.push(sid);
      // disconnectServer clears mainHelperChannel and retains remount targets
      await this.disconnectServer(configId, sid);
    }

    for (const key of [...this.commandListeners.keys()]) {
      if (!key.startsWith(prefix)) continue;
      // key format: `${configId}:${sid}:cmd:${channelId}`
      const parts = key.split(':');
      const sid = parseInt(parts[1], 10);
      const channelId = parseInt(parts[3], 10);
      if (!Number.isNaN(sid) && !Number.isNaN(channelId)) {
        cmdListenersToRestore.push({ sid, channelId });
      }
      const client = this.commandListeners.get(key);
      if (client) {
        await client.destroy();
        this.commandListeners.delete(key);
      }
    }

    for (const sid of sidsToReconnect) {
      try {
        await this.connectServer(configId, sid);
      } catch (err: any) {
        console.error(`[EventBridge] Reconnect failed for ${configId}:${sid}: ${err.message}`);
      }
    }

    for (const { sid, channelId } of cmdListenersToRestore) {
      try {
        await this.connectCommandListener(configId, sid, channelId);
      } catch (err: any) {
        console.error(`[EventBridge] CMD listener reconnect failed for ${configId}:${sid}:${channelId}: ${err.message}`);
      }
    }
  }

  isConnected(configId: number, sid: number): boolean {
    const key = this.makeKey(configId, sid);
    const client = this.connections.get(key);
    return client?.isConnected ?? false;
  }

  /**
   * Remaining flood/reconnect pause for an existing SSH client (0 if unknown).
   * Reports pause even while still connected — flood 524 sets pause before forced disconnect.
   */
  getSshReconnectPauseSeconds(configId: number, sid: number): number {
    const key = this.makeKey(configId, sid);
    const client = this.connections.get(key);
    if (!client) return 0;
    return client.getReconnectPauseSeconds();
  }

  /** The main SSH session is usable for music discovery only after event registration. */
  isRegistered(configId: number, sid: number): boolean {
    return this.registered.has(this.makeKey(configId, sid)) && this.isConnected(configId, sid);
  }

  /**
   * Execute a raw ServerQuery command on an existing (or on-demand) SSH connection.
   * Reuses the same connection used for event listening — no extra server slots.
   */
  async executeCommand(configId: number, sid: number, command: string): Promise<string> {
    const key = this.makeKey(configId, sid);
    let client = this.connections.get(key);

    // Connect on demand if no connection exists yet
    if (!client || !client.isConnected) {
      await this.connectServer(configId, sid);
      client = this.connections.get(key);
      if (!client || !client.isConnected) {
        const serverConfig = await this.prisma.tsServerConfig.findUnique({
          where: { id: configId },
          select: { sshUsername: true, sshPassword: true, sshPort: true },
        });
        if (!serverConfig?.sshUsername || !serverConfig.sshPassword || !serverConfig.sshPort) {
          throw new Error('SSH credentials not configured for this server');
        }
        const fatal = this.fatalSshFailures.get(key);
        if (fatal) {
          throw new Error(formatFatalSshFailureMessage(fatal));
        }
        // Reconnecting / flood cooldown — not a permanent credentials failure.
        throw new Error('SSH not connected');
      }
    }

    return client.executeCommand(command);
  }

  getConnectedKeys(): string[] {
    return Array.from(this.connections.keys());
  }

  private commandListeners: Map<string, SshQueryClient> = new Map();

  private makeCmdKey(configId: number, sid: number, channelId: number): string {
    return `${configId}:${sid}:cmd:${channelId}`;
  }

  async connectCommandListener(configId: number, sid: number, channelId: number): Promise<void> {
    const key = this.makeCmdKey(configId, sid, channelId);
    if (this.commandListeners.has(key)) return;

    const serverConfig = await this.prisma.tsServerConfig.findUnique({ where: { id: configId } });
    if (!serverConfig?.sshUsername || !serverConfig.sshPassword || !serverConfig.sshPort) {
      console.warn(
        `[EventBridge] CMD listener skipped for ${key}: server config missing SSH credentials ` +
          `(music !commands outside the bot's voice channel require SSH ServerQuery)`,
      );
      return;
    }

    const client = new SshQueryClient(this.buildSshOptions({
      id: serverConfig.id,
      host: serverConfig.host,
      sshPort: serverConfig.sshPort,
      sshUsername: serverConfig.sshUsername,
      sshPassword: serverConfig.sshPassword,
      sshHostKeyFingerprint: serverConfig.sshHostKeyFingerprint,
    }));

    client.on('ready', async () => {
      console.log(`[EventBridge] CMD listener SSH connected for ${key}`);
      try {
        await client.registerCommandListener(sid, channelId);
      } catch (err: any) {
        console.error(`[EventBridge] CMD listener register failed for ${key}: ${err.message}`);
      }
    });

    client.on('event', (eventName: string, data: Record<string, string>) => {
      // Marker so engine can keep backward compatibility:
      // triggers WITHOUT channelId should only react to base connection events.
      // Do not run leave-cache eviction here — main SSH stream owns enrichment (#74).
      const enriched = { ...data, __cmd_listener_channel_id: String(channelId) };
      this.emit('tsEvent', configId, sid, eventName, enriched);
    });

    client.on('error', (err: Error) => console.error(`[EventBridge] CMD listener SSH error for ${key}: ${err.message}`));
    client.on('close', () => console.log(`[EventBridge] CMD listener SSH disconnected for ${key}`));

    this.commandListeners.set(key, client);
    try { await client.connect(); } catch (err: any) {
      console.error(`[EventBridge] CMD listener initial connect failed for ${key}: ${err.message}`);
      if (client.hasFatalError) this.commandListeners.delete(key);
    }
  }

  async disconnectCommandListener(configId: number, sid: number, channelId: number): Promise<void> {
    const key = this.makeCmdKey(configId, sid, channelId);
    const client = this.commandListeners.get(key);
    if (client) {
      await client.destroy();
      this.commandListeners.delete(key);
    }
  }

  getCommandListenerChannelIds(configId: number, sid: number): number[] {
    const prefix = `${configId}:${sid}:cmd:`;
    return Array.from(this.commandListeners.keys())
      .filter(k => k.startsWith(prefix))
      .map(k => parseInt(k.split(':').pop() || '0', 10))
      .filter(n => Number.isFinite(n) && n > 0);
  }

  getCommandListenerKeys(): string[] {
    return Array.from(this.commandListeners.keys());
  }

  /** Channel id the main SSH Query client is parked in for music chat (0 = unknown). */
  getMainHelperChannelId(configId: number, sid: number): number {
    return this.mainHelperChannel.get(this.makeKey(configId, sid)) || 0;
  }

  private enqueueMainHelperWork(fn: () => Promise<void>): Promise<void> {
    const run = this.mainHelperChain.then(fn, fn);
    this.mainHelperChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Park the main EventBridge SSH Query client in `channelId` so it can hear
   * channel chat there (TS Query textchannel is view-scoped). One connection —
   * no second CMD-listener SSH login.
   */
  async ensureHelperInChannel(configId: number, sid: number, channelId: number): Promise<boolean> {
    if (channelId <= 0) return false;
    let ok = false;
    await this.enqueueMainHelperWork(async () => {
      ok = await this.moveMainHelperToChannel(configId, sid, channelId);
    });
    return ok;
  }

  private async moveMainHelperToChannel(
    configId: number,
    sid: number,
    channelId: number,
  ): Promise<boolean> {
    const pairKey = this.makeKey(configId, sid);
    if (this.mainHelperChannel.get(pairKey) === channelId && this.isConnected(configId, sid)) {
      return true;
    }

    try {
      if (!this.isConnected(configId, sid)) {
        await this.connectServer(configId, sid);
      }
      const client = this.connections.get(pairKey);
      if (!client?.isConnected) {
        console.warn(`[EventBridge] ensureHelperInChannel skipped ${pairKey}: SSH not connected`);
        return false;
      }

      const { parseQueryResponse } = await import('@ts6/common');
      await client.executeCommand(`use sid=${sid}`);
      const who = await client.executeCommand('whoami');
      const first = (who.split('\n')[0] || '').trim();
      const me = parseQueryResponse(first)[0] || {};
      const clid =
        me.clid ??
        me.client_id ??
        me.clientid ??
        me.clientId ??
        (() => {
          const m = first.match(/(?:clid|client_id)=(\d+)/);
          return m?.[1];
        })();
      if (!clid) {
        console.warn(`[EventBridge] ensureHelperInChannel ${pairKey}: whoami has no clid`);
        return false;
      }
      const myCid = parseInt(String(me.cid || me.client_channel_id || me.client_cid || '0'), 10);
      if (!Number.isFinite(myCid) || myCid !== channelId) {
        await client.executeCommand(`clientmove clid=${clid} cid=${channelId}`);
      }
      this.mainHelperChannel.set(pairKey, channelId);
      this.mainHelperRemountAfterReconnect.delete(pairKey);
      console.log(`[EventBridge] Main SSH helper parked in cid=${channelId} for ${pairKey}`);
      return true;
    } catch (err: any) {
      console.warn(
        `[EventBridge] ensureHelperInChannel failed for ${pairKey} cid=${channelId}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Send channel chat via the main SSH connection (hop into the channel if needed).
   * Does not require a per-channel CMD listener SSH session.
   */
  async sendChannelText(
    configId: number,
    sid: number,
    channelId: number,
    msg: string,
    opts?: { helperNickname?: string },
  ): Promise<boolean> {
    let ok = false;
    await this.enqueueMainHelperWork(async () => {
      ok = await this.sendChannelTextOnMain(configId, sid, channelId, msg, opts);
    });
    return ok;
  }

  private async sendChannelTextOnMain(
    configId: number,
    sid: number,
    channelId: number,
    msg: string,
    opts?: { helperNickname?: string },
  ): Promise<boolean> {
    const pairKey = this.makeKey(configId, sid);
    try {
      if (!this.isConnected(configId, sid)) {
        await this.connectServer(configId, sid);
      }
      const client = this.connections.get(pairKey);
      if (!client?.isConnected) {
        console.warn(`[EventBridge] sendChannelText skipped for ${pairKey}: main SSH not connected`);
        return false;
      }

      const { tsEscape } = await import('../voice/tslib/commands.js');
      const { parseQueryResponse } = await import('@ts6/common');

      await client.executeCommand(`use sid=${sid}`);
      const who = await client.executeCommand('whoami');
      const first = (who.split('\n')[0] || '').trim();
      const me = parseQueryResponse(first)[0] || {};
      const clid =
        me.clid ??
        me.client_id ??
        me.clientid ??
        me.clientId ??
        (() => {
          const m = first.match(/(?:clid|client_id)=(\d+)/);
          return m?.[1];
        })();
      if (!clid) {
        console.warn(
          `[EventBridge] sendChannelText failed for ${pairKey}: whoami returned no clid; not sending`,
        );
        return false;
      }
      const myCid = parseInt(
        String(me.cid || me.client_channel_id || me.client_cid || '0'),
        10,
      );
      // TS error 770 (already member) is treated as success by SshQueryClient.
      if (!Number.isFinite(myCid) || myCid !== channelId) {
        await client.executeCommand(`clientmove clid=${clid} cid=${channelId}`);
      }
      this.mainHelperChannel.set(pairKey, channelId);
      this.mainHelperRemountAfterReconnect.delete(pairKey);

      const previousNick = (me.client_nickname || '').trim();
      const helperBase = opts?.helperNickname?.trim();
      let helperApplied = false;
      if (helperBase) {
        const uniqueHelper = `${helperBase}-${channelId}`.slice(0, 30);
        try {
          await client.executeCommand(
            `clientupdate client_nickname=${tsEscape(uniqueHelper)}`,
          );
          helperApplied = true;
        } catch (err: any) {
          console.warn(
            `[EventBridge] helper nickname update failed for ${pairKey}: ${err.message}`,
          );
        }
      }

      try {
        await client.executeCommand(`sendtextmessage targetmode=2 msg=${tsEscape(msg)}`);
      } finally {
        if (helperApplied && previousNick) {
          try {
            await client.executeCommand(
              `clientupdate client_nickname=${tsEscape(previousNick.slice(0, 30))}`,
            );
          } catch (err: any) {
            console.warn(
              `[EventBridge] failed to restore nickname for ${pairKey}: ${err.message}`,
            );
          }
        }
      }
      return true;
    } catch (err: any) {
      console.error(
        `[EventBridge] sendChannelText failed for ${pairKey} cid=${channelId}: ${err.message}`,
      );
      return false;
    }
  }

  async destroy(): Promise<void> {
    const closing: Promise<void>[] = [];

    for (const client of this.connections.values()) {
      closing.push(client.destroy());
    }
    this.connections.clear();
    this.mainHelperChannel.clear();
    this.mainHelperRemountAfterReconnect.clear();
    this.sessionOwners.clear();
    this.clientCache.clearAll();

    for (const client of this.commandListeners.values()) {
      closing.push(client.destroy());
    }
    this.commandListeners.clear();

    await Promise.all(closing);
    this.removeAllListeners();
  }
}
