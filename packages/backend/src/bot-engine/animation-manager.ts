import { TSApiError } from '../middleware/error-handler.js';
import type { WebQueryClient } from '../ts-client/webquery-client.js';

export type AnimationStyle = 'scroll' | 'typewriter' | 'bounce' | 'blink' | 'wave' | 'alternateCase';

export interface AnimationConfig {
  channelId: string;
  text: string;
  style: AnimationStyle;
  intervalSeconds: number;
  prefix: string;
  timezone?: string;
  /** When true, BotEngine ignores notifychanneledited for this channel. */
  suppressEditEvents?: boolean;
}

interface ActiveAnimation {
  timer: ReturnType<typeof setInterval>;
  sid: number;
  channelId: string;
  suppressEditEvents: boolean;
}

const MAX_CHANNEL_NAME = 40;
const ERROR_LOG_THROTTLE_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

function isConnectionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('epipe') ||
    lower.includes('etimedout') ||
    lower.includes('econnaborted') ||
    lower.includes('connection failed') ||
    lower.includes('flood')
  );
}

// --- Frame generators (pure functions, return string[]) ---

function generateScrollFrames(text: string, prefix: string): string[] {
  const maxLen = MAX_CHANNEL_NAME - prefix.length;
  if (text.length <= maxLen) {
    // Pad and scroll
    const padded = text + '   ';
    const frames: string[] = [];
    for (let i = 0; i < padded.length; i++) {
      const shifted = padded.slice(i) + padded.slice(0, i);
      frames.push(prefix + shifted.slice(0, maxLen));
    }
    return frames;
  }
  // Text longer than width — scroll through it
  const padded = text + '   ';
  const frames: string[] = [];
  for (let i = 0; i < padded.length; i++) {
    const shifted = padded.slice(i) + padded.slice(0, i);
    frames.push(prefix + shifted.slice(0, maxLen));
  }
  return frames;
}

function generateTypewriterFrames(text: string, prefix: string): string[] {
  const maxLen = MAX_CHANNEL_NAME - prefix.length;
  const display = text.slice(0, maxLen);
  const frames: string[] = [];
  // Build up character by character
  for (let i = 1; i <= display.length; i++) {
    frames.push(prefix + display.slice(0, i));
  }
  // Hold the full text for a few frames
  frames.push(prefix + display);
  frames.push(prefix + display);
  frames.push(prefix + display);
  // Clear
  frames.push(prefix + ' ');
  frames.push(prefix + ' ');
  return frames;
}

function generateBounceFrames(text: string, prefix: string): string[] {
  const maxLen = MAX_CHANNEL_NAME - prefix.length;
  if (text.length >= maxLen) return [prefix + text.slice(0, maxLen)];
  const space = maxLen - text.length;
  const frames: string[] = [];
  // Move right
  for (let i = 0; i <= space; i++) {
    frames.push(prefix + ' '.repeat(i) + text);
  }
  // Move left (skip endpoints to avoid double frames)
  for (let i = space - 1; i > 0; i--) {
    frames.push(prefix + ' '.repeat(i) + text);
  }
  return frames;
}

function generateBlinkFrames(text: string, prefix: string): string[] {
  const maxLen = MAX_CHANNEL_NAME - prefix.length;
  const display = text.slice(0, maxLen);
  const dashes = display.replace(/[^ ]/g, '-');
  return [
    prefix + display,
    prefix + display,
    prefix + dashes,
    prefix + display,
    prefix + display,
    prefix + ' '.repeat(display.length),
  ];
}

function generateWaveFrames(text: string, prefix: string): string[] {
  const maxLen = MAX_CHANNEL_NAME - prefix.length;
  const decorPairs = [
    ['» ', ' «'],
    ['»» ', ' ««'],
    ['»»» ', ' «««'],
    ['»» ', ' ««'],
    ['» ', ' «'],
    ['', ''],
  ];
  const frames: string[] = [];
  for (const [left, right] of decorPairs) {
    const available = maxLen - left.length - right.length;
    const display = text.slice(0, Math.max(0, available));
    frames.push(prefix + left + display + right);
  }
  return frames;
}

function generateAlternateCaseFrames(text: string, prefix: string): string[] {
  const maxLen = MAX_CHANNEL_NAME - prefix.length;
  const display = text.slice(0, maxLen);
  const frame1 = display.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join('');
  const frame2 = display.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
  return [prefix + frame1, prefix + frame2];
}

function generateFrames(text: string, style: AnimationStyle, prefix: string): string[] {
  switch (style) {
    case 'scroll': return generateScrollFrames(text, prefix);
    case 'typewriter': return generateTypewriterFrames(text, prefix);
    case 'bounce': return generateBounceFrames(text, prefix);
    case 'blink': return generateBlinkFrames(text, prefix);
    case 'wave': return generateWaveFrames(text, prefix);
    case 'alternateCase': return generateAlternateCaseFrames(text, prefix);
    default: return [prefix + text.slice(0, MAX_CHANNEL_NAME - prefix.length)];
  }
}

// Lightweight {{time.*}} resolver (no API calls, just Date)
function resolveTimeVars(text: string, timezone?: string): string {
  if (!text.includes('{{time.')) return text;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  let hours: number, minutes: number, seconds: number;
  let day: number, month: number, year: number;

  if (timezone && timezone !== 'UTC') {
    try {
      const fmt = (opts: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone }).format(now);
      hours = Number(fmt({ hour: 'numeric', hour12: false }));
      minutes = Number(fmt({ minute: 'numeric' }));
      seconds = Number(fmt({ second: 'numeric' }));
      day = Number(fmt({ day: 'numeric' }));
      month = Number(fmt({ month: 'numeric' }));
      year = Number(fmt({ year: 'numeric' }));
    } catch {
      hours = now.getHours(); minutes = now.getMinutes(); seconds = now.getSeconds();
      day = now.getDate(); month = now.getMonth() + 1; year = now.getFullYear();
    }
  } else {
    hours = now.getHours(); minutes = now.getMinutes(); seconds = now.getSeconds();
    day = now.getDate(); month = now.getMonth() + 1; year = now.getFullYear();
  }

  return text
    .replace(/\{\{time\.hours\}\}/g, pad(hours))
    .replace(/\{\{time\.minutes\}\}/g, pad(minutes))
    .replace(/\{\{time\.seconds\}\}/g, pad(seconds))
    .replace(/\{\{time\.time\}\}/g, `${pad(hours)}:${pad(minutes)}`)
    .replace(/\{\{time\.date\}\}/g, `${pad(day)}.${pad(month)}.${year}`)
    .replace(/\{\{time\.day\}\}/g, pad(day))
    .replace(/\{\{time\.month\}\}/g, pad(month))
    .replace(/\{\{time\.year\}\}/g, String(year))
    .replace(/\{\{time\.timestamp\}\}/g, String(Math.floor(now.getTime() / 1000)));
}

export class AnimationManager {
  private animations: Map<number, ActiveAnimation> = new Map();

  startAnimation(
    flowId: number,
    sid: number,
    config: AnimationConfig,
    client: WebQueryClient,
  ): void {
    // Stop existing animation for this flow
    this.stopAnimation(flowId);

    // Floor at 2s — 1s channeledit ticks flood TeamSpeak query anti-spam and starve the WebUI.
    const intervalMs = Math.max(2_000, config.intervalSeconds * 1000);

    // Tick runtime state lives in this closure (not on the map entry) so overlapping
    // setInterval callbacks can skip/backoff without racing the Map record.
    const state = {
      frameIndex: 0,
      inFlight: false,
      consecutiveErrors: 0,
      pauseUntil: 0,
      lastErrorLogAt: 0,
      suppressedErrorCount: 0,
    };

    const logError = (message: string) => {
      const now = Date.now();
      if (now - state.lastErrorLogAt < ERROR_LOG_THROTTLE_MS) {
        state.suppressedErrorCount++;
        return;
      }
      const extra = state.suppressedErrorCount > 0
        ? ` (+${state.suppressedErrorCount} similar since last log)`
        : '';
      console.error(`[AnimationManager] Flow ${flowId} channel update error: ${message}${extra}`);
      state.lastErrorLogAt = now;
      state.suppressedErrorCount = 0;
    };

    const tick = async () => {
      if (state.inFlight) return;
      if (Date.now() < state.pauseUntil) return;

      state.inFlight = true;
      try {
        // Resolve {{time.*}} in text each tick (for dynamic content)
        const resolvedText = resolveTimeVars(config.text, config.timezone);
        const frames = generateFrames(resolvedText, config.style, config.prefix);
        if (frames.length === 0) return;

        const channelName = frames[state.frameIndex % frames.length];
        state.frameIndex++;

        await client.executePost(sid, 'channeledit', {
          cid: config.channelId,
          channel_name: channelName,
        }, { priority: 'low' });

        state.consecutiveErrors = 0;
        state.pauseUntil = 0;
      } catch (err: any) {
        const code = err instanceof TSApiError ? err.code : undefined;
        const message = String(err?.message || err);
        // 304 = name unchanged — treat as success for backoff purposes
        if (code === 304 || message.includes('304')) {
          state.consecutiveErrors = 0;
          state.pauseUntil = 0;
          return;
        }

        logError(message);

        // Back off only on connection/socket failures so API errors don't inflate delay.
        if (isConnectionError(message)) {
          state.consecutiveErrors++;
          const backoffMs = Math.min(
            MAX_BACKOFF_MS,
            intervalMs * Math.pow(2, Math.min(state.consecutiveErrors, 5)),
          );
          state.pauseUntil = Date.now() + backoffMs;
        }
      } finally {
        state.inFlight = false;
      }
    };

    // Run first tick immediately
    tick();

    const timer = setInterval(tick, intervalMs);
    this.animations.set(flowId, {
      timer,
      sid,
      channelId: String(config.channelId),
      suppressEditEvents: config.suppressEditEvents !== false,
    });

    console.log(`[AnimationManager] Started animation for flow ${flowId}: style=${config.style}, interval=${config.intervalSeconds}s (effective ${intervalMs}ms), channel=${config.channelId}, suppressEditEvents=${config.suppressEditEvents !== false}`);
  }

  stopAnimation(flowId: number): void {
    const anim = this.animations.get(flowId);
    if (anim) {
      clearInterval(anim.timer);
      this.animations.delete(flowId);
      console.log(`[AnimationManager] Stopped animation for flow ${flowId}`);
    }
  }

  stopAll(): void {
    for (const [, anim] of this.animations) {
      clearInterval(anim.timer);
    }
    this.animations.clear();
  }

  getActiveCount(): number {
    return this.animations.size;
  }

  /** True when an active animated-channel node asked to suppress edits for this cid. */
  isChannelEditSuppressed(sid: number, channelId: string | number): boolean {
    const cid = String(channelId);
    for (const anim of this.animations.values()) {
      if (anim.suppressEditEvents && anim.sid === sid && anim.channelId === cid) {
        return true;
      }
    }
    return false;
  }
}
