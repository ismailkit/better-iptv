import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getPlayerCapabilities, PLAYER_STATE_EVENT, type MpvState } from '../lib/player';
import { usePlayerUi } from '../stores/player-ui-store';
import { logger } from '../lib/logger';

/**
 * Connects the page to the in-app player: asks once whether playback
 * happens inside the window, and mirrors MPV's `player-state` events into
 * `usePlayerUi`. `refreshKey` re-reads the capability (after Settings).
 */
export function usePlayerBridge(refreshKey: unknown = 0) {
  useEffect(() => {
    let cancelled = false;
    getPlayerCapabilities()
      .then((c) => {
        if (!cancelled) usePlayerUi.getState().setCapabilities(c.embedded, c.embedded_supported);
      })
      .catch((err) => {
        logger.warn('Failed to read player capabilities:', err);
        if (!cancelled) usePlayerUi.getState().setCapabilities(false, false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    const unlisten = listen<MpvState>(PLAYER_STATE_EVENT, (e) => {
      usePlayerUi.getState().mergeMpv(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
}
