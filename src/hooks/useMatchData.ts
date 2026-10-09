import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import {
  findMatch,
  getHighlights,
  getLineups,
  getMatch,
  getSportsQuota,
  localDate,
  matchPhase,
  type Highlight,
  type Lineups,
  type SportsMatch,
  type SportsQuota,
} from '../lib/sports';
import { detectMatch, matchKey, type DetectedMatch } from '../lib/matchDetect';
import { useDisplayStore } from '../stores/display-store';
import type { EpgEntry } from '../stores/player-store';
import type { Channel } from '../types';

/**
 * Match data shared by everything that shows it (the match centre, the
 * player's insights panel, the mini player's score), so one match is never
 * asked for twice. Requests happen only while something showing the match
 * is open (`enabled`), and live updates follow the user's interval; the
 * backend adds its own cache on top. See src/lib/sports.ts.
 */

type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: string };

export interface MatchEntry {
  status: 'finding' | 'found' | 'none' | 'error';
  /** The fixture the lookup found (score as of then). */
  summary?: SportsMatch;
  /** Full details, refreshed while live. */
  details?: SportsMatch;
  error?: string;
  updatedAt?: number;
  highlights: Loadable<Highlight[]>;
  lineups: Loadable<Lineups>;
}

interface SportsState {
  entries: Record<string, MatchEntry>;
  quota: SportsQuota | null;
  patch: (key: string, patch: Partial<MatchEntry>) => void;
  setQuota: (q: SportsQuota) => void;
}

const emptyEntry = (): MatchEntry => ({
  status: 'finding',
  highlights: { status: 'idle' },
  lineups: { status: 'idle' },
});

export const useSportsStore = create<SportsState>((set) => ({
  entries: {},
  quota: null,
  patch: (key, patch) =>
    set((s) => ({
      entries: { ...s.entries, [key]: { ...(s.entries[key] ?? emptyEntry()), ...patch } },
    })),
  setQuota: (quota) => set({ quota }),
}));

const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function message(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return 'Something went wrong';
}

export function refreshQuota() {
  getSportsQuota()
    .then((q) => useSportsStore.getState().setQuota(q))
    .catch(() => {});
}

/** The match a channel is showing now, from its guide entry; null when none. */
export function detectChannelMatch(
  channel: Pick<Channel, 'name' | 'group_name'> | null | undefined,
  epg: EpgEntry | undefined
): DetectedMatch | null {
  if (!channel || !epg?.current) return null;
  return detectMatch(epg.current, epg.currentCategory, channel.group_name, channel.name);
}

/**
 * The live data of a detected match. `startMs` is when the programme began
 * (it picks the day to look on). Fetches only while `enabled`.
 */
export function useMatchData(
  detected: DetectedMatch | null,
  startMs: number | undefined,
  enabled: boolean
) {
  const pollSecs = useDisplayStore((s) => s.sportsPollSecs);
  const { date, timezone } = useMemo(() => localDate(startMs ?? Date.now()), [startMs]);
  const key = detected ? matchKey(detected, date) : null;
  const entry = useSportsStore((s) => (key ? s.entries[key] : undefined));
  const quota = useSportsStore((s) => s.quota);

  const loadDetails = useCallback(async (k: string, sport: DetectedMatch['sport'], id: number) => {
    try {
      const details = await once(`m:${k}`, () => getMatch(sport, id));
      useSportsStore.getState().patch(k, { details, updatedAt: Date.now(), error: undefined });
    } catch (err) {
      useSportsStore.getState().patch(k, { error: message(err) });
    } finally {
      refreshQuota();
    }
  }, []);

  // Find the fixture once per match and day.
  useEffect(() => {
    if (!enabled || !detected || !key) return;
    const current = useSportsStore.getState().entries[key];
    if (current && current.status !== 'error') return;
    useSportsStore.getState().patch(key, { status: 'finding', error: undefined });
    once(`f:${key}`, () => findMatch(detected.sport, detected.home, detected.away, date, timezone))
      .then((found) => {
        useSportsStore
          .getState()
          .patch(key, found ? { status: 'found', summary: found } : { status: 'none' });
        if (found) void loadDetails(key, detected.sport, found.id);
      })
      .catch((err) =>
        useSportsStore.getState().patch(key, { status: 'error', error: message(err) })
      )
      .finally(refreshQuota);
  }, [enabled, detected, key, date, timezone, loadDetails]);

  // Live updates: every `pollSecs` while live and on screen; an upcoming
  // match is checked again at kickoff; a finished one never.
  const matchId = entry?.summary?.id;
  const shown = entry?.details ?? entry?.summary;
  const phase = matchPhase(shown);
  const kickoff = shown?.date ? Date.parse(shown.date) : NaN;
  useEffect(() => {
    if (!enabled || !detected || !key || !matchId) return;
    let delay: number | null = null;
    if (phase === 'live' || phase === 'break') delay = pollSecs * 1000;
    else if (phase === 'upcoming' && Number.isFinite(kickoff))
      delay = Math.max(kickoff - Date.now() + 60_000, pollSecs * 1000);
    if (delay === null) return;
    const id = window.setTimeout(() => {
      if (document.visibilityState === 'visible') void loadDetails(key, detected.sport, matchId);
      else useSportsStore.getState().patch(key, { updatedAt: Date.now() }); // re-arm
    }, delay);
    return () => window.clearTimeout(id);
  }, [enabled, detected, key, matchId, phase, kickoff, pollSecs, entry?.updatedAt, loadDetails]);

  const refresh = useCallback(() => {
    if (detected && key && matchId) void loadDetails(key, detected.sport, matchId);
  }, [detected, key, matchId, loadDetails]);

  const loadHighlights = useCallback(() => {
    if (!detected || !key || !matchId) return;
    const s = useSportsStore.getState();
    if (
      s.entries[key]?.highlights.status === 'ok' ||
      s.entries[key]?.highlights.status === 'loading'
    )
      return;
    s.patch(key, { highlights: { status: 'loading' } });
    getHighlights(detected.sport, matchId)
      .then((data) => useSportsStore.getState().patch(key, { highlights: { status: 'ok', data } }))
      .catch((err) =>
        useSportsStore
          .getState()
          .patch(key, { highlights: { status: 'error', error: message(err) } })
      )
      .finally(refreshQuota);
  }, [detected, key, matchId]);

  const loadLineups = useCallback(() => {
    if (!detected || !key || !matchId) return;
    const s = useSportsStore.getState();
    if (s.entries[key]?.lineups.status === 'ok' || s.entries[key]?.lineups.status === 'loading')
      return;
    s.patch(key, { lineups: { status: 'loading' } });
    getLineups(detected.sport, matchId)
      .then((data) => useSportsStore.getState().patch(key, { lineups: { status: 'ok', data } }))
      .catch((err) =>
        useSportsStore.getState().patch(key, { lineups: { status: 'error', error: message(err) } })
      )
      .finally(refreshQuota);
  }, [detected, key, matchId]);

  useEffect(() => {
    if (enabled && !quota) refreshQuota();
  }, [enabled, quota]);

  return { entry, match: shown ?? null, phase, quota, refresh, loadHighlights, loadLineups };
}
