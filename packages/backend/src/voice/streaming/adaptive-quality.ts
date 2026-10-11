/**
 * Adaptive Auto quality: step the preset down when the encoder cannot keep up
 * and back up once it has recovered, from the sidecar's encode-health samples.
 *
 * The controller only decides. It holds no timers and reads no clock, so the
 * caller passes the time and applies (then commits) each decision.
 */

import type { VideoQualityAdaptation, VideoQualityChange, VideoStreamPresetKey } from '@ts6/common';
import { describeDuration } from './lifecycle.js';
import { PRESET_ORDER } from './types.js';

export interface AdaptiveQualityTuning {
  /** Sustained below-realtime seconds (as the sidecar counts them) before stepping down. */
  overloadSecs: number;
  /** Speed at or above this counts as healthy. Between the sidecar's 0.9 and this, nothing changes. */
  healthySpeed: number;
  /** Healthy time needed before stepping up; doubles after each failed step up, up to the maximum. */
  recoveryMs: number;
  maxRecoveryMs: number;
  /** Minimum gap between two changes in either direction. */
  cooldownMs: number;
  /** Older samples say nothing about the encoder now. */
  maxSampleAgeSecs: number;
}

export const ADAPTIVE_QUALITY_TUNING: AdaptiveQualityTuning = {
  overloadSecs: 30,
  healthySpeed: 0.97,
  recoveryMs: 120_000,
  maxRecoveryMs: 1_800_000,
  cooldownMs: 60_000,
  maxSampleAgeSecs: 15,
};

/** The encode-health fields the controller reads (a subset of the sidecar's). */
export interface EncodeHealthSample {
  speed: number | null;
  belowRealtime: boolean;
  belowRealtimeSecs: number;
  sampleAgeSecs: number;
}

export interface QualityDecision {
  direction: 'down' | 'up';
  from: VideoStreamPresetKey;
  to: VideoStreamPresetKey;
  reason: string;
}

export class AdaptiveQualityController {
  private _current: VideoStreamPresetKey;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private healthySince: number | null = null;
  /** The last change was a step up that has not yet held for a recovery window. */
  private upgradeOnTrial = false;
  private failedUpgrades = 0;
  private lastChange: VideoQualityChange | null = null;
  private changes = 0;

  constructor(
    /** Preset Auto started at. The controller never goes above it. */
    readonly ceiling: VideoStreamPresetKey,
    private readonly tuning: AdaptiveQualityTuning = ADAPTIVE_QUALITY_TUNING,
  ) {
    this._current = ceiling;
  }

  get current(): VideoStreamPresetKey {
    return this._current;
  }

  /**
   * Read one health sample and say whether quality should change. Nothing
   * changes until the caller commits the decision.
   */
  observe(sample: EncodeHealthSample, nowMs: number): QualityDecision | null {
    const t = this.tuning;
    if (sample.sampleAgeSecs > t.maxSampleAgeSecs) {
      this.healthySince = null;
      return null;
    }
    const cooling = nowMs - this.lastChangeAt < t.cooldownMs;

    if (sample.belowRealtime && sample.belowRealtimeSecs >= t.overloadSecs) {
      this.healthySince = null;
      const lower = this.neighbour(-1);
      if (!lower || cooling) return null;
      const speed = sample.speed != null ? `${sample.speed.toFixed(2)}x` : 'unknown speed';
      return {
        direction: 'down',
        from: this._current,
        to: lower,
        reason: `Encoding stayed below realtime (${speed} for ${Math.round(sample.belowRealtimeSecs)} s) at ${this._current}`,
      };
    }

    const healthy = sample.belowRealtimeSecs <= 0 && sample.speed != null && sample.speed >= t.healthySpeed;
    if (!healthy) {
      this.healthySince = null;
      return null;
    }
    this.healthySince ??= nowMs;
    const stableMs = nowMs - this.healthySince;
    if (this.upgradeOnTrial && stableMs >= t.recoveryMs) {
      this.upgradeOnTrial = false;
      this.failedUpgrades = 0;
    }

    const higher = this.neighbour(1);
    if (!higher || cooling) return null;
    if (stableMs < this.recoveryWindowMs()) return null;
    return {
      direction: 'up',
      from: this._current,
      to: higher,
      reason: `Encoding held realtime for ${describeDuration(stableMs / 1000)} at ${this._current}`,
    };
  }

  /** The caller applied `decision`: record it and start the cooldown. */
  commit(decision: QualityDecision, nowMs: number): VideoQualityChange {
    let reason = decision.reason;
    if (decision.direction === 'down') {
      if (this.upgradeOnTrial) {
        this.failedUpgrades++;
        reason += `; trying ${decision.from} again after ${describeDuration(this.recoveryWindowMs() / 1000)} of steady encoding`;
      }
      this.upgradeOnTrial = false;
    } else {
      this.upgradeOnTrial = true;
    }
    this._current = decision.to;
    this.lastChangeAt = nowMs;
    this.healthySince = null;
    this.changes++;
    this.lastChange = { direction: decision.direction, from: decision.from, to: decision.to, at: nowMs, reason };
    return this.lastChange;
  }

  /** The caller could not apply a decision: stay put and wait out a cooldown before the next one. */
  reject(nowMs: number): void {
    this.lastChangeAt = nowMs;
    this.healthySince = null;
  }

  /** The encoder restarted for another reason (volume): earlier healthy samples no longer count. */
  noteRestart(): void {
    this.healthySince = null;
  }

  snapshot(): VideoQualityAdaptation {
    return { ceiling: this.ceiling, lastChange: this.lastChange, changes: this.changes };
  }

  private recoveryWindowMs(): number {
    return Math.min(this.tuning.recoveryMs * 2 ** this.failedUpgrades, this.tuning.maxRecoveryMs);
  }

  /** The next preset down (-1) or up (+1), never above the ceiling. */
  private neighbour(step: -1 | 1): VideoStreamPresetKey | null {
    const i = PRESET_ORDER.indexOf(this._current) + step;
    if (i < 0 || i > PRESET_ORDER.indexOf(this.ceiling)) return null;
    return PRESET_ORDER[i];
  }
}
