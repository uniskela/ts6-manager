import { create } from 'zustand';
import type { MediaSessionConflictBody } from '@ts6/common';

interface PendingSwitch {
  conflict: MediaSessionConflictBody;
  resolve: (confirmed: boolean) => void;
}

interface MediaSwitchState {
  pending: PendingSwitch | null;
  /** Ask the user to confirm replacing the conflicting sessions. */
  request: (conflict: MediaSessionConflictBody) => Promise<boolean>;
  answer: (confirmed: boolean) => void;
}

export const useMediaSwitchStore = create<MediaSwitchState>((set, get) => ({
  pending: null,
  request: (conflict) => new Promise<boolean>((resolve) => {
    // A newer prompt supersedes an unanswered one (the older request is cancelled).
    get().pending?.resolve(false);
    set({ pending: { conflict, resolve } });
  }),
  answer: (confirmed) => {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(confirmed);
  },
}));
