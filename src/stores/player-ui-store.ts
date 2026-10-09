import { create } from 'zustand';
import type { MpvState } from '../lib/player';

/**
 * The in-app player's state on the page: what MPV last reported (the
 * backend sends it at most four times a second), and how the player is
 * shown. Components select the fields they draw, so a position update only
 * re-renders the timeline, not the whole player.
 */
export type PlayerMode = 'mini' | 'full';

interface PlayerUiState {
  /** Whether playback happens inside the window; null until the backend said. */
  embedded: boolean | null;
  embeddedSupported: boolean;
  mpv: MpvState;
  /** When `mpv` last changed (ms), to interpolate the position between updates. */
  receivedAt: number;
  mode: PlayerMode;
  fullscreen: boolean;
  /** The match side panel in the full player. */
  insightsOpen: boolean;
  setCapabilities: (embedded: boolean, supported: boolean) => void;
  mergeMpv: (patch: MpvState) => void;
  resetMpv: () => void;
  setMode: (mode: PlayerMode) => void;
  setFullscreen: (on: boolean) => void;
  setInsightsOpen: (open: boolean) => void;
}

export const usePlayerUi = create<PlayerUiState>((set) => ({
  embedded: null,
  embeddedSupported: false,
  mpv: {},
  receivedAt: 0,
  mode: 'mini',
  fullscreen: false,
  insightsOpen: false,
  setCapabilities: (embedded, embeddedSupported) => set({ embedded, embeddedSupported }),
  // The backend sends the whole mirror each time; merging keeps fields a
  // restarted process has not reported yet.
  mergeMpv: (patch) => set((s) => ({ mpv: { ...s.mpv, ...patch }, receivedAt: Date.now() })),
  resetMpv: () => set({ mpv: {}, receivedAt: 0 }),
  setMode: (mode) => set({ mode }),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  setInsightsOpen: (insightsOpen) => set({ insightsOpen }),
}));
