import type { MediaCommandPermissions } from '@ts6/common';
import { authorizeMediaCommand, type MediaCommandIdentity } from '../voice/media-command-permissions.js';
import { defaultMediaUrlDeps, type MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';
import {
  parseVolumeLevel,
  pausePlayback,
  resumePlayback,
  skipPlayback,
  stopPlayback,
} from '../voice/commands/playback.js';
import { applyMediaUrlToBot, beginChatMediaRequest } from '../voice/commands/queue.js';
import { validateUrl } from '../utils/url-validator.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import type { CommandResult, DiscordCommandIntent, GuildBinding } from './adapter.js';
import { formatBotNowPlaying, formatBotQueue } from './music-inspect.js';
import { PHASE_2A_MUSIC_COMMANDS, PHASE_2B_1_MUSIC_COMMANDS, isMusicCommand } from './music.js';
import { MemoryReplayGuard, type ReplayGuard } from './security.js';

export type MusicCommandService = {
  execute(intent: DiscordCommandIntent, binding: GuildBinding | null): Promise<CommandResult>;
};

export type MusicServiceDeps = {
  getBot(botId: number): VoiceBot | null;
  virtualServerIdForBot(botId: number): number;
  loadMediaPermissions(serverConfigId: number, virtualServerId: number): Promise<MediaCommandPermissions>;
  identityForUser?(userId: string): MediaCommandIdentity | undefined;
  pipeline?: MediaUrlPipelineDeps;
  validateUrl?: (url: string) => Promise<{ valid: boolean; error?: string }>;
  replay?: ReplayGuard;
  nowMs?: () => number;
};

const READY = new Set<string>([...PHASE_2A_MUSIC_COMMANDS, ...PHASE_2B_1_MUSIC_COMMANDS]);

function fail(code: CommandResult['code'], content: string, ack: CommandResult['ack'] = 'immediate'): CommandResult {
  return { ok: false, code, ephemeral: true, content, ack };
}

function ok(content: string, ack: CommandResult['ack'] = 'immediate'): CommandResult {
  return { ok: true, ephemeral: true, content, ack };
}

function playQuery(intent: DiscordCommandIntent): string {
  const args = intent.args ?? {};
  return (args.query ?? args.url ?? args.source ?? '').trim();
}

function volumeArg(intent: DiscordCommandIntent): string {
  const args = intent.args ?? {};
  return (args.level ?? args.volume ?? args.value ?? '').trim();
}

function mediaArgs(intent: DiscordCommandIntent): string {
  if (intent.command === 'play') return playQuery(intent) || 'url';
  if (intent.command === 'volume') return volumeArg(intent);
  return '';
}

export function createMusicCommandService(deps: MusicServiceDeps): MusicCommandService {
  const replay = deps.replay ?? new MemoryReplayGuard();

  function claim(intent: DiscordCommandIntent, ack: CommandResult['ack']): CommandResult | null {
    if (intent.idempotencyKey && !replay.claim(intent.idempotencyKey, deps.nowMs?.() ?? Date.now())) {
      return ok('Already handled.', ack);
    }
    return null;
  }

  async function execute(intent: DiscordCommandIntent, binding: GuildBinding | null): Promise<CommandResult> {
    if (!binding || binding.revoked) {
      return fail('unpaired', 'This Discord server is not connected to TS6 Manager.');
    }
    if (!isMusicCommand(intent.command)) {
      return fail('unauthorized', 'Unknown command.');
    }
    if (!READY.has(intent.command)) {
      return fail('not_implemented', 'This music command is not available yet.');
    }
    if (binding.botId == null) {
      return fail('unavailable', 'No music bot is configured for this Discord server.');
    }

    const bot = deps.getBot(binding.botId);
    if (!bot) return fail('unavailable', 'Music bot is unavailable.');

    const policy = await deps.loadMediaPermissions(bot.currentConfig.serverConfigId, deps.virtualServerIdForBot(bot.currentConfig.id));
    const identity = deps.identityForUser?.(intent.userId) ?? {};
    if (!authorizeMediaCommand(policy, intent.command, identity, mediaArgs(intent))) {
      return fail('unauthorized', 'You do not have permission to use this command.');
    }

    if (intent.command === 'nowplaying') return ok(formatBotNowPlaying(bot));
    if (intent.command === 'queue') return ok(formatBotQueue(bot));
    if (intent.command === 'volume' && !volumeArg(intent)) {
      return ok(`Volume: ${bot.currentConfig.volume}%`);
    }

    if (intent.command === 'pause') {
      const replayed = claim(intent, 'immediate');
      if (replayed) return replayed;
      const result = pausePlayback(bot);
      if (result === 'idle') return fail('unavailable', 'Nothing is playing.');
      return ok('Paused.');
    }
    if (intent.command === 'resume') {
      const replayed = claim(intent, 'immediate');
      if (replayed) return replayed;
      const result = resumePlayback(bot);
      if (result === 'idle') return fail('unavailable', 'Nothing is paused.');
      return ok('Resumed.');
    }
    if (intent.command === 'skip') {
      const replayed = claim(intent, 'immediate');
      if (replayed) return replayed;
      try {
        const result = await skipPlayback(bot, { replaceSessionIds: [] });
        if (result.kind === 'skipped') return ok(`Skipped to: ${result.title}`);
        return ok('Queue empty — playback stopped.');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Skip failed.';
        return fail('unavailable', message);
      }
    }
    if (intent.command === 'stop') {
      const replayed = claim(intent, 'immediate');
      if (replayed) return replayed;
      stopPlayback(bot);
      return ok('Playback stopped.');
    }
    if (intent.command === 'volume') {
      const level = parseVolumeLevel(volumeArg(intent));
      if (level == null) return fail('unavailable', 'Usage: /volume <0-100>');
      const replayed = claim(intent, 'immediate');
      if (replayed) return replayed;
      try {
        await bot.applyVolume(level);
        return ok(`Volume set to ${bot.currentConfig.volume}%.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not set volume.';
        return fail('unavailable', `Could not set volume: ${message}`);
      }
    }

    const query = playQuery(intent);
    if (!query) return fail('unavailable', 'Usage: /play <url>', 'deferred');
    const replayed = claim(intent, 'deferred');
    if (replayed) return replayed;
    if (!/^https?:\/\//i.test(query)) {
      return fail('unavailable', 'Phase 2A accepts HTTP(S) URLs only.', 'deferred');
    }
    const check = await (deps.validateUrl ?? validateUrl)(query);
    if (!check.valid) return fail('unavailable', check.error ?? 'That URL is not allowed.', 'deferred');

    try {
      const applied = await applyMediaUrlToBot(
        {
          voiceBotManager: { getBot: (id) => deps.getBot(id) ?? undefined },
          virtualServerIdForBot: deps.virtualServerIdForBot,
          saveMusicRequest: () => {},
          chatMusicSwitch: () => ({ replaceSessionIds: [] }),
        },
        binding.botId,
        bot,
        query,
        beginChatMediaRequest(binding.botId),
        deps.pipeline ?? defaultMediaUrlDeps(),
      );
      if (!applied) return fail('unavailable', 'Could not start playback.', 'deferred');
      if (applied.alreadyPlaying) {
        return ok(`Queued: ${applied.first.artist ?? ''} - ${applied.first.title}${applied.playlistNote}`.replace(' - ', ' — ').trim(), 'deferred');
      }
      return ok(`Now playing: ${applied.first.artist ?? ''} — ${applied.first.title}${applied.playlistNote}`, 'deferred');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Playback failed.';
      return fail('unavailable', message, 'deferred');
    }
  }

  return { execute };
}
