export interface ReconnectAttemptState {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

/** True while either a retry timer is pending or the reconnect attempt itself is running. */
export function reconnectAttemptBusy(state: ReconnectAttemptState): boolean {
  return state.timer !== null || state.inFlight;
}
