/**
 * Gate cosmetic bot WebQuery traffic until EventBridge has finished
 * `registerEvents` (or SSH is not in play for the pair).
 */

export interface BotQueryReadyInput {
  /** EventBridge.isRegistered(configId, sid) */
  isRegistered: boolean;
  /** EventBridge.isConnected(configId, sid) */
  isConnected: boolean;
  /** Remaining SSH flood/reconnect pause in ms */
  sshReconnectPauseMs: number;
  /**
   * True when this pair is expected to complete SSH event registration.
   * False when SSH credentials are missing / connect was skipped — WebQuery-only.
   */
  expectsSshRegistration: boolean;
}

export interface BotQueryReadyResult {
  ready: boolean;
  /** Suggested hold/skip duration when not ready (0 when ready). */
  holdMs: number;
}

const REGISTERING_HOLD_MS = 2_000;
const RECONNECTING_HOLD_MS = 5_000;

/**
 * Whether AnimationManager / cron channel-edit flows should send Query traffic.
 */
export function evaluateBotQueryReady(input: BotQueryReadyInput): BotQueryReadyResult {
  if (input.sshReconnectPauseMs > 0) {
    return { ready: false, holdMs: input.sshReconnectPauseMs };
  }

  if (!input.expectsSshRegistration) {
    return { ready: true, holdMs: 0 };
  }

  if (input.isRegistered) {
    return { ready: true, holdMs: 0 };
  }

  // Connected but registerEvents still in flight (classic boot race).
  if (input.isConnected) {
    return { ready: false, holdMs: REGISTERING_HOLD_MS };
  }

  // SSH expected but down / reconnecting — hold cosmetic edits.
  return { ready: false, holdMs: RECONNECTING_HOLD_MS };
}

/** True when BotEngine may arm animations/cron for a pair for the first time. */
export function canArmBotsForPair(input: BotQueryReadyInput): boolean {
  if (!input.expectsSshRegistration) return true;
  return input.isRegistered;
}

/**
 * Animation 90s fallback may relax the SSH-expectation gate for tick holds, but
 * must not override an in-progress `registerEvents` window while SSH is up.
 */
export function applyAnimationFallbackToHoldInput(
  input: BotQueryReadyInput,
  animationFallback: boolean,
): BotQueryReadyInput {
  if (!animationFallback) return input;
  if (input.expectsSshRegistration && input.isConnected && !input.isRegistered) {
    return input;
  }
  return { ...input, expectsSshRegistration: false };
}
