import { invoke } from '@tauri-apps/api/core';

/**
 * Live sports data (Highlightly) for matches spotted in the guide. The
 * backend caches every answer and minds the daily request quota; see
 * src-tauri/src/sports/mod.rs.
 */

/** Sports the API serves, as they appear in its paths. */
export type Sport =
  | 'football'
  | 'american-football'
  | 'basketball'
  | 'hockey'
  | 'baseball'
  | 'rugby'
  | 'handball'
  | 'volleyball'
  | 'cricket'
  | 'nba'
  | 'nhl';

export const SPORT_LABELS: Record<Sport, string> = {
  football: 'Football',
  'american-football': 'American football',
  basketball: 'Basketball',
  hockey: 'Ice hockey',
  baseball: 'Baseball',
  rugby: 'Rugby',
  handball: 'Handball',
  volleyball: 'Volleyball',
  cricket: 'Cricket',
  nba: 'NBA',
  nhl: 'NHL',
};

export interface TeamRef {
  id?: number;
  name: string;
  logo?: string | null;
}

export interface MatchEvent {
  team?: TeamRef;
  /** Match clock: "23", "45+2", "90+4". */
  time: string;
  type: string;
  player?: string | null;
  playerId?: number | null;
  assist?: string | null;
  substituted?: string | null;
}

export interface StatItem {
  displayName: string;
  value: number | string | null;
}

export interface TeamStats {
  team: TeamRef;
  statistics: StatItem[];
}

export interface Prediction {
  type?: string;
  description?: string;
  generatedAt?: string;
  probabilities?: { home?: string; draw?: string; away?: string };
}

/** A match as /matches and /matches/{id} return it; detail fields are optional. */
export interface SportsMatch {
  id: number;
  date: string;
  round?: string | null;
  country?: { code?: string; name?: string; logo?: string | null } | null;
  league?: { id?: number; name?: string; logo?: string | null; season?: number } | null;
  homeTeam: TeamRef & { topPlayers?: TopPlayer[]; shots?: Shot[] };
  awayTeam: TeamRef & { topPlayers?: TopPlayer[]; shots?: Shot[] };
  state?: {
    description?: string;
    clock?: number | null;
    score?: { current?: string | null; penalties?: string | null } | null;
  } | null;
  events?: MatchEvent[];
  statistics?: TeamStats[];
  venue?: { name?: string; city?: string; country?: string; capacity?: string } | null;
  referee?: { name?: string; nationality?: string } | null;
  forecast?: { status?: string; temperature?: string } | null;
  predictions?: { prematch?: Prediction[]; live?: Prediction[] } | null;
  news?: Array<{ url: string; title: string; image?: string; datePublished?: string }>;
}

export interface TopPlayer {
  name: string;
  position?: string;
  statistics?: Array<{ name: string; value: unknown }>;
}

export interface Shot {
  playerName?: string;
  time?: string;
  outcome?: string;
  goalTarget?: string;
}

export interface Highlight {
  id: number;
  type?: string;
  imgUrl?: string | null;
  title: string;
  description?: string | null;
  url: string;
  embedUrl?: string | null;
  source?: string | null;
  channel?: string | null;
}

export interface LineupPlayer {
  id?: number;
  name: string;
  number?: number;
  position?: string;
}

export interface LineupTeam {
  name: string;
  logo?: string | null;
  formation?: string | null;
  initialLineup?: LineupPlayer[][] | LineupPlayer[];
  substitutes?: LineupPlayer[];
}

export interface Lineups {
  homeTeam?: LineupTeam;
  awayTeam?: LineupTeam;
}

export interface SportsQuota {
  has_key: boolean;
  /** -1 until a request this session reported it. */
  remaining: number;
  limit: number;
}

export function getSportsQuota(): Promise<SportsQuota> {
  return invoke('sports_quota');
}

export function setSportsKey(key: string): Promise<void> {
  return invoke('sports_set_key', { key });
}

export function findMatch(
  sport: Sport,
  home: string,
  away: string,
  date: string,
  timezone: string
): Promise<SportsMatch | null> {
  return invoke('sports_find_match', { sport, home, away, date, timezone });
}

export function getMatch(sport: Sport, id: number): Promise<SportsMatch> {
  return invoke('sports_match', { sport, id });
}

export function getHighlights(sport: Sport, matchId: number): Promise<Highlight[]> {
  return invoke('sports_highlights', { sport, matchId });
}

export function getLineups(sport: Sport, matchId: number): Promise<Lineups> {
  return invoke('sports_lineups', { sport, matchId });
}

export const LINEUP_SPORTS: Sport[] = ['football', 'american-football', 'baseball', 'nba', 'nhl'];

// ---------- Match state ----------

export type MatchPhase = 'upcoming' | 'live' | 'break' | 'finished' | 'other';

export function matchPhase(m: SportsMatch | null | undefined): MatchPhase {
  const d = (m?.state?.description ?? '').toLowerCase();
  if (!d) return 'other';
  if (d.includes('finished') || d.includes('after') || d.includes('ended')) return 'finished';
  if (d.includes('not started') || d.includes('announced') || d.includes('scheduled'))
    return 'upcoming';
  if (d.includes('half time') || d.includes('break')) return 'break';
  if (d.includes('postponed') || d.includes('cancel') || d.includes('abandon')) return 'other';
  return 'live';
}

/** "2 - 1" → [2, 1]. */
export function parseScore(score?: string | null): [number, number] | null {
  const m = score?.match(/(\d+)\s*-\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ---------- Event kinds (icons, colours, what goes on the timeline) ----------

export type EventKind =
  | 'goal'
  | 'own-goal'
  | 'penalty'
  | 'missed-penalty'
  | 'yellow'
  | 'second-yellow'
  | 'red'
  | 'sub'
  | 'var'
  | 'other';

export function eventKind(type: string): EventKind {
  const t = type.toLowerCase();
  if (t.includes('own goal')) return 'own-goal';
  if (t.includes('missed penalty')) return 'missed-penalty';
  if (t.includes('penalty')) return 'penalty';
  if (t.includes('goal')) return 'goal';
  if (t.includes('second yellow') || t.includes('yellow red')) return 'second-yellow';
  if (t.includes('yellow')) return 'yellow';
  if (t.includes('red')) return 'red';
  if (t.includes('subst')) return 'sub';
  if (t.includes('var')) return 'var';
  return 'other';
}

/** Kinds worth a mark on the player's timeline (substitutions would crowd it). */
export const TIMELINE_KINDS: EventKind[] = [
  'goal',
  'own-goal',
  'penalty',
  'missed-penalty',
  'yellow',
  'second-yellow',
  'red',
  'var',
];

export function isScoring(kind: EventKind) {
  return kind === 'goal' || kind === 'own-goal' || kind === 'penalty';
}

// ---------- Match clock → wall clock → stream position ----------

/** Minutes into the match: "45+2" → 47, "90+4" → 94, "67'" → 67. */
export function eventMinute(time: string): number {
  const m = time.match(/(\d+)(?:\s*\+\s*(\d+))?/);
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
}

/**
 * When an event happened, from the kickoff and the match clock. The clock
 * stops at half time, so second-half minutes add the interval (15 min) and
 * extra time adds the break before it (5 min). Stoppage time ("45+2")
 * belongs to the half it extends. An estimate: it does not know how long
 * each break really took.
 */
export function eventWallTime(kickoffMs: number, time: string): number {
  const m = time.match(/(\d+)(?:\s*\+\s*(\d+))?/);
  const base = m ? Number(m[1]) : 0;
  const added = m?.[2] ? Number(m[2]) : 0;
  let pause = 0;
  if (base > 45) pause += 15;
  if (base > 90) pause += 5;
  if (base > 105) pause += 2;
  return kickoffMs + (base + added + pause) * 60_000;
}

/**
 * Where a moment of real time sits in a live stream: the stream's live edge
 * (`liveEnd`, in stream seconds) shows what happened `delaySecs` ago, as
 * IPTV runs behind the broadcast. Null when it is outside the buffer.
 */
export function streamPosition(
  wallMs: number,
  nowMs: number,
  liveEnd: number,
  start: number,
  delaySecs: number
): number | null {
  const pos = liveEnd - (nowMs - delaySecs * 1000 - wallMs) / 1000;
  return pos >= start && pos <= liveEnd ? pos : null;
}

/**
 * The score after each event, in order: what each goal made it.
 *
 * The API does not say whether an own goal's team is the side that scored
 * it or the side it counted for, so both readings are tried and the one
 * that ends on the match's actual score wins (default: counted for the
 * other side, which is how most feeds list it).
 */
export function runningScores(
  events: MatchEvent[],
  home: TeamRef,
  finalScore?: [number, number] | null
): Array<[number, number]> {
  const isHome = (e: MatchEvent) =>
    e.team?.name === home.name || (e.team?.id != null && e.team.id === home.id);
  const tally = (ownGoalForOther: boolean) => {
    let h = 0;
    let a = 0;
    return events.map((e): [number, number] => {
      const kind = eventKind(e.type);
      if (isScoring(kind)) {
        const credited = kind === 'own-goal' && ownGoalForOther ? !isHome(e) : isHome(e);
        if (credited) h++;
        else a++;
      }
      return [h, a];
    });
  };
  const usual = tally(true);
  if (!finalScore || !events.some((e) => eventKind(e.type) === 'own-goal')) return usual;
  const last = usual[usual.length - 1];
  if (last && last[0] === finalScore[0] && last[1] === finalScore[1]) return usual;
  const other = tally(false);
  const end = other[other.length - 1];
  return end && end[0] === finalScore[0] && end[1] === finalScore[1] ? other : usual;
}

/** Date (YYYY-MM-DD) and IANA zone of a moment in the user's time zone, for /matches. */
export function localDate(ms: number): { date: string; timezone: string } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return { date, timezone };
}

/** Search links for sites with deeper coverage than the API. */
export function externalLinks(home: string, away: string): Array<{ label: string; url: string }> {
  const q = encodeURIComponent(`${home} vs ${away}`);
  return [
    { label: 'SofaScore', url: `https://www.google.com/search?q=${q}+site%3Asofascore.com` },
    {
      label: 'FlashScore',
      url: `https://www.flashscore.com/search/?q=${encodeURIComponent(home)}`,
    },
    { label: 'ESPN', url: `https://www.google.com/search?q=${q}+site%3Aespn.com` },
    { label: 'Search', url: `https://www.google.com/search?q=${q}` },
  ];
}
