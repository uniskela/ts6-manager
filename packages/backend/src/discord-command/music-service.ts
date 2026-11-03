import type { MediaCommandPermissions } from '@ts6/common';
import { authorizeMediaCommand, type MediaCommandIdentity } from '../voice/media-command-permissions.js';
import { defaultMediaUrlDeps, type MediaUrlPipelineDeps } from '../voice/media-url-pipeline.js';
import { findSongForQuery } from '../voice/audio/youtube.js';
import {
  MAX_SONG_QUERY_LENGTH,
  parseVolumeLevel,
  pausePlayback,
  resumePlayback,
  skipPlayback,
  stopPlayback,
} from '../voice/commands/playback.js';
import { applyMediaUrlToBot, beginChatMediaRequest } from '../voice/commands/queue.js';
import {
  addUrlToPlaylist,
  createServerPlaylist,
  enqueueSavedPlaylist,
  formatNamedMatchError,
  formatPlaylistList,
  loadPlaylistSummaries,
  loadRadioStations,
  matchNamed,
  radioQueueItem,
  removeTrackFromPlaylist,
  type PlaylistCatalog,
} from '../voice/commands/library.js';
import { formatRadioListMessage } from '../voice/ts6-chat-format.js';
import { validateUrl } from '../utils/url-validator.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import type { CommandResult, DiscordCommandIntent, GuildBinding } from './adapter.js';
import { formatBotNowPlaying, formatBotQueue } from './music-inspect.js';
import { PHASE_2A_MUSIC_COMMANDS, PHASE_2B_1_MUSIC_COMMANDS, PHASE_2B_2_MUSIC_COMMANDS, isMusicCommand } from './music.js';
import { MemoryCommandIdempotency, musicIdempotencyKey } from './idempotency.js';

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
  /** Outcome-aware Discord interaction idempotency (not HMAC replay). */
  idempotency?: MemoryCommandIdempotency;
  nowMs?: () => number;
  prisma?: PlaylistCatalog;
  findSong?: (query: string, signal?: AbortSignal) => ReturnType<typeof findSongForQuery>;
  searchTimeoutMs?: number;
};

const SEARCH_TIMEOUT_MS = 12_000;

const READY = new Set<string>([...PHASE_2A_MUSIC_COMMANDS, ...PHASE_2B_1_MUSIC_COMMANDS, ...PHASE_2B_2_MUSIC_COMMANDS]);
const PLAYLIST_EDITS = new Set(['create', 'add', 'remove']);

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

function arg(intent: DiscordCommandIntent, ...keys: string[]): string {
  const args = intent.args ?? {};
  for (const key of keys) {
    const value = args[key]?.trim();
    if (value) return value;
  }
  return '';
}

function playlistAction(intent: DiscordCommandIntent): 'list' | 'play' | 'create' | 'add' | 'remove' {
  const action = arg(intent, 'subcommand', 'action', 'op').toLowerCase();
  if (action === 'list' || action === 'play' || action === 'create' || action === 'add' || action === 'remove') return action;
  return arg(intent, 'name', 'playlist', 'query') ? 'play' : 'list';
}

function radioAction(intent: DiscordCommandIntent): 'list' | 'play' {
  const action = arg(intent, 'subcommand', 'action', 'op').toLowerCase();
  if (action === 'list' || action === 'play') return action;
  return arg(intent, 'station', 'name', 'query', 'id') ? 'play' : 'list';
}

function mediaArgs(intent: DiscordCommandIntent): string {
  if (intent.command === 'play') return playQuery(intent) || 'url';
  if (intent.command === 'volume') return volumeArg(intent);
  if (intent.command === 'playlist') {
    const action = playlistAction(intent);
    return action === 'list' ? '' : action;
  }
  if (intent.command === 'radio') {
    const action = radioAction(intent);
    return action === 'list' ? '' : action;
  }
  return '';
}

export function createMusicCommandService(deps: MusicServiceDeps): MusicCommandService {
  const idempotency = deps.idempotency ?? new MemoryCommandIdempotency();

  async function once(
    intent: DiscordCommandIntent,
    ack: CommandResult['ack'],
    run: () => Promise<CommandResult>,
  ): Promise<CommandResult> {
    const key = musicIdempotencyKey(intent);
    if (!key) return run();
    const nowMs = () => deps.nowMs?.() ?? Date.now();
    const gate = idempotency.begin(key, nowMs());
    if (gate.kind === 'pending') {
      return fail('unavailable', 'Request is already in progress.', ack);
    }
    if (gate.kind === 'full') {
      return fail('unavailable', 'Too many in-flight requests. Try again shortly.', ack);
    }
    if (gate.kind === 'replay') return gate.result;
    try {
      const result = await run();
      idempotency.complete(key, result, nowMs());
      return result;
    } catch (err) {
      const failed = fail(
        'unavailable',
        err instanceof Error ? err.message : 'Command failed.',
        ack,
      );
      idempotency.complete(key, failed, nowMs());
      return failed;
    }
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
    if (intent.command === 'playlist' && PLAYLIST_EDITS.has(playlistAction(intent)) && intent.ts6Role !== 'admin') {
      return fail('unauthorized', 'You do not have permission to edit playlists.');
    }

    if (intent.command === 'nowplaying') return ok(formatBotNowPlaying(bot));
    if (intent.command === 'queue') return ok(formatBotQueue(bot));
    if (intent.command === 'volume' && !volumeArg(intent)) {
      return ok(`Volume: ${bot.currentConfig.volume}%`);
    }

    if (intent.command === 'pause') {
      return once(intent, 'immediate', async () => {
        const result = pausePlayback(bot);
        if (result === 'idle') return fail('unavailable', 'Nothing is playing.');
        return ok('Paused.');
      });
    }
    if (intent.command === 'resume') {
      return once(intent, 'immediate', async () => {
        const result = resumePlayback(bot);
        if (result === 'idle') return fail('unavailable', 'Nothing is paused.');
        return ok('Resumed.');
      });
    }
    if (intent.command === 'skip') {
      return once(intent, 'immediate', async () => {
        try {
          const result = await skipPlayback(bot, { replaceSessionIds: [] });
          if (result.kind === 'skipped') return ok(`Skipped to: ${result.title}`);
          return ok('Queue empty — playback stopped.');
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Skip failed.';
          return fail('unavailable', message);
        }
      });
    }
    if (intent.command === 'stop') {
      return once(intent, 'immediate', async () => {
        stopPlayback(bot);
        return ok('Playback stopped.');
      });
    }
    if (intent.command === 'volume') {
      const level = parseVolumeLevel(volumeArg(intent));
      if (level == null) return fail('unavailable', 'Usage: /volume <0-100>');
      return once(intent, 'immediate', async () => {
        try {
          await bot.applyVolume(level);
          return ok(`Volume set to ${bot.currentConfig.volume}%.`);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Could not set volume.';
          return fail('unavailable', `Could not set volume: ${message}`);
        }
      });
    }

    if (intent.command === 'playlist' || intent.command === 'radio') {
      return catalogCommand(intent, binding, bot);
    }

    const query = playQuery(intent);
    if (!query) return fail('unavailable', 'Usage: /play <url|song name>', 'deferred');
    return once(intent, 'deferred', async () => {
      const request = beginChatMediaRequest(binding.botId!);
      const cancelled = () => fail('unavailable', 'Search cancelled.', 'deferred');
      let url = query;
      if (!/^https?:\/\//i.test(query)) {
        const songQuery = query.trim().slice(0, MAX_SONG_QUERY_LENGTH);
        try {
          const timeout = AbortSignal.timeout(deps.searchTimeoutMs ?? SEARCH_TIMEOUT_MS);
          const signal = AbortSignal.any([request.signal, timeout]);
          const findSong = deps.findSong ?? ((q, s) => findSongForQuery(q, undefined, s));
          const song = await findSong(songQuery, signal);
          if (request.isCancelled()) {
            request.discard();
            return cancelled();
          }
          if (!song) {
            request.discard();
            return fail('unavailable', `No results for "${songQuery}".`, 'deferred');
          }
          url = song.url;
        } catch (err) {
          const wasCancelled = request.isCancelled() || (err instanceof Error && err.name === 'AbortError');
          request.discard();
          if (wasCancelled) return cancelled();
          const name = err instanceof Error ? err.name : '';
          if (name === 'TimeoutError') return fail('unavailable', 'Search timed out.', 'deferred');
          return fail('unavailable', 'Search failed.', 'deferred');
        }
      }
      if (request.isCancelled()) {
        request.discard();
        return cancelled();
      }
      const check = await (deps.validateUrl ?? validateUrl)(url);
      if (request.isCancelled()) {
        request.discard();
        return cancelled();
      }
      if (!check.valid) {
        request.discard();
        return fail('unavailable', check.error ?? 'That URL is not allowed.', 'deferred');
      }

      try {
        const applied = await applyMediaUrlToBot(
          {
            voiceBotManager: { getBot: (id) => deps.getBot(id) ?? undefined },
            virtualServerIdForBot: deps.virtualServerIdForBot,
            saveMusicRequest: () => {},
            chatMusicSwitch: () => ({ replaceSessionIds: [] }),
          },
          binding.botId!,
          bot,
          url,
          request,
          deps.pipeline ?? defaultMediaUrlDeps(),
        );
        if (!applied) {
          request.discard();
          return fail('unavailable', 'Could not start playback.', 'deferred');
        }
        if (applied.alreadyPlaying) {
          return ok(`Queued: ${applied.first.artist ?? ''} - ${applied.first.title}${applied.playlistNote}`.replace(' - ', ' — ').trim(), 'deferred');
        }
        return ok(`Now playing: ${applied.first.artist ?? ''} — ${applied.first.title}${applied.playlistNote}`, 'deferred');
      } catch (err) {
        request.discard();
        const message = err instanceof Error ? err.message : 'Playback failed.';
        return fail('unavailable', message, 'deferred');
      }
    });
  }

  async function catalogCommand(
    intent: DiscordCommandIntent,
    binding: GuildBinding,
    bot: VoiceBot,
  ): Promise<CommandResult> {
    if (!deps.prisma) return fail('unavailable', 'Music catalog is unavailable.');
    const serverConfigId = bot.currentConfig.serverConfigId;
    if (!serverConfigId) return fail('unavailable', 'No server configured.');

    if (intent.command === 'radio') {
      const action = radioAction(intent);
      if (action === 'list') {
        const stations = await loadRadioStations(deps.prisma, serverConfigId);
        if (!stations.length) return ok('No radio stations configured.');
        return ok(formatRadioListMessage(stations, '/radio play <id>'));
      }
      const query = arg(intent, 'station', 'name', 'query', 'id');
      if (!query) return fail('unavailable', 'Usage: /radio play <station>', 'deferred');
      return once(intent, 'deferred', async () => {
        const request = beginChatMediaRequest(binding.botId!);
        const stations = await loadRadioStations(deps.prisma!, serverConfigId);
        if (request.isCancelled()) {
          request.discard();
          return fail('unavailable', 'Radio play cancelled.', 'deferred');
        }
        const matches = matchNamed(stations, query);
        if (matches.length !== 1) {
          request.discard();
          return fail('unavailable', formatNamedMatchError('station', matches, '/radio list'), 'deferred');
        }
        const item = radioQueueItem(matches[0]);
        try {
          request.accept();
          if (request.isCancelled()) {
            request.discard();
            return fail('unavailable', 'Radio play cancelled.', 'deferred');
          }
          await bot.playStream(item, { replaceSessionIds: [] });
          if (request.isCancelled()) {
            if (bot.nowPlaying === item) bot.stopAudio({ keepPendingRequests: true });
            return fail('unavailable', 'Radio play cancelled.', 'deferred');
          }
          return ok(`Now playing: ${matches[0].name}`, 'deferred');
        } catch (err) {
          request.discard();
          const message = err instanceof Error ? err.message : 'Radio playback failed.';
          return fail('unavailable', message, 'deferred');
        }
      });
    }

    const action = playlistAction(intent);
    if (action === 'list') {
      return ok(formatPlaylistList(await loadPlaylistSummaries(deps.prisma, serverConfigId)));
    }
    if (action === 'play') {
      const query = arg(intent, 'name', 'playlist', 'query');
      if (!query) return fail('unavailable', 'Usage: /playlist play <name>', 'deferred');
      return once(intent, 'deferred', async () => {
        const result = await enqueueSavedPlaylist(deps.prisma!, bot, query, {
          musicSwitch: { replaceSessionIds: [] },
          listHint: '/playlist list',
          isCurrent: () => deps.getBot(binding.botId!) === bot,
        });
        if (!result.ok) return fail('unavailable', result.message, 'deferred');
        return ok(`Queued playlist "${result.name.slice(0, 60)}" (${result.count} tracks).`, 'deferred');
      });
    }
    if (action === 'create') {
      const name = arg(intent, 'name', 'playlist', 'query');
      return once(intent, 'immediate', async () => {
        const result = await createServerPlaylist(deps.prisma!, {
          name,
          serverConfigId,
          musicBotId: binding.botId!,
        });
        if (!result.ok) return fail('unavailable', result.message);
        return ok(`Created playlist "${result.name.slice(0, 60)}" [${result.id}].`);
      });
    }
    if (action === 'add') {
      const name = arg(intent, 'name', 'playlist');
      const url = arg(intent, 'url', 'query', 'source');
      if (!name || !url) return fail('unavailable', 'Usage: /playlist add <name> <URL>', 'deferred');
      if (!/^https?:\/\//i.test(url)) return fail('unavailable', 'Playlist add accepts HTTP(S) URLs only.', 'deferred');
      const check = await (deps.validateUrl ?? validateUrl)(url);
      if (!check.valid) return fail('unavailable', check.error ?? 'That URL is not allowed.', 'deferred');
      return once(intent, 'deferred', async () => {
        const result = await addUrlToPlaylist(deps.prisma!, { query: name, url, serverConfigId });
        if (!result.ok) return fail('unavailable', result.message, 'deferred');
        return ok(`Added to "${result.playlist.slice(0, 60)}": ${result.title.slice(0, 80)}`, 'deferred');
      });
    }
    const name = arg(intent, 'name', 'playlist');
    const track = arg(intent, 'track', 'song', 'title');
    if (!name || !track) return fail('unavailable', 'Usage: /playlist remove <name> <track>');
    return once(intent, 'immediate', async () => {
      const result = await removeTrackFromPlaylist(deps.prisma!, { query: name, track, serverConfigId });
      if (!result.ok) return fail('unavailable', result.message);
      return ok(`Removed from "${result.playlist.slice(0, 60)}": ${result.title.slice(0, 80)}`);
    });
  }

  return { execute };
}
