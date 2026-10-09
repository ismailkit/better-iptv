import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentAges } from '../lib/tauri';
import { logger } from '../lib/logger';

const REFRESH_MS = 5 * 60_000;

/**
 * The minimum age of what is on now, per normalized EPG id, for the
 * channel list's age filter. Only fetched while `enabled` (the filter is
 * on); read again every few minutes, as programmes change, and after an
 * EPG refresh. Null until the first answer.
 */
export function useCurrentAges(enabled: boolean): Map<string, number> | null {
  const [ages, setAges] = useState<Map<string, number> | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setKey((k) => k + 1), REFRESH_MS);
    const unlisten = listen('epg-refreshed', () => setKey((k) => k + 1));
    return () => {
      clearInterval(id);
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getCurrentAges()
      .then((map) => {
        if (!cancelled) setAges(new Map(Object.entries(map)));
      })
      .catch((err) => {
        logger.warn('Failed to read the ages of current programmes:', err);
        if (!cancelled) setAges(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key]);

  return enabled ? ages : null;
}
