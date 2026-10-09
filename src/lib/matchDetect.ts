import type { Sport } from './sports';

/**
 * Spots a match in what the guide says is on: "Premier League: Arsenal v
 * Chelsea", "LIVE NBA: Celtics @ Lakers", "Football - Real Madrid vs
 * Barcelona (L)". Runs locally on every card, so it costs no API requests;
 * the API is only asked once the user opens the match.
 *
 * Two things must agree before something counts as a match: a "Team v Team"
 * shape, and a sport signal from the title, the programme's genre, the
 * channel's category or its name. "Kramer vs. Kramer" on a movie channel is
 * not a match.
 */

export interface DetectedMatch {
  sport: Sport;
  home: string;
  away: string;
  /** Competition named in the title, when there is one ("Premier League"). */
  competition?: string;
}

// Ordered: the specific leagues before the sports they belong to.
const SPORT_SIGNALS: Array<[Sport, RegExp]> = [
  ['nba', /\bnba\b/i],
  ['nhl', /\bnhl\b/i],
  ['american-football', /\b(nfl|american football|super bowl|ncaaf|college football)\b/i],
  ['baseball', /\b(mlb|baseball|world series)\b/i],
  ['hockey', /\b(hockey|khl|shl|liiga)\b/i],
  ['basketball', /\b(basket(ball)?|euroleague|eurocup|acb|wnba|ncaab|bbl)\b/i],
  ['rugby', /\b(rugby|six nations|super rugby|top 14|premiership rugby|urc)\b/i],
  ['handball', /\bhandball\b/i],
  ['volleyball', /\bvolley(ball)?\b/i],
  ['cricket', /\b(cricket|ipl|t20|odi|test match|the ashes|big bash)\b/i],
  [
    'football',
    /\b(football|soccer|f[uú]tbol|futebol|calcio|fu[sß]ball|premier league|la ?liga|serie a|bundesliga|ligue 1|eredivisie|champions league|europa league|conference league|uefa|fifa|efl|championship|fa cup|carabao|copa|mls|liga mx|super lig|primeira|allsvenskan|eliteserien|superliga|ucl|uel|epl|world cup|euro 20\d\d|friendly|qualifier|matchday)\b/i,
  ],
];

/** "Competition: …" prefixes worth keeping as the competition name. */
const PREFIX_SPLIT = /^(.{2,60}?)\s*[:|–—]\s+(.+)$/;
const LIVE_MARKERS =
  /\b(live|en vivo|ao vivo|en direct|direkt|diretta|directo|(?:full )?replay|highlights)\b[:!]?/gi;
const TRAILING_NOISE =
  /\s*(\((?:l|live|r|hd|fhd|4k|uhd|\d{4}|[^)]{0,30}round[^)]*|[^)]{0,30}week[^)]*)\)|\[[^\]]*\])\s*$/i;

/** Separators between the two teams. "@" means away @ home (US style). */
const SEPARATORS: Array<[RegExp, boolean]> = [
  [/\s+vs?\.?\s+/i, false],
  [/\s+v\.\s+/i, false],
  [/\s+x\s+/i, false],
  [/\s+@\s+/, true],
  [/\s+[-–]\s+/, false],
];

function sportOf(...texts: Array<string | undefined>): Sport | null {
  const blob = texts.filter(Boolean).join(' • ');
  for (const [sport, re] of SPORT_SIGNALS) if (re.test(blob)) return sport;
  return null;
}

function cleanTeam(s: string): string {
  return s
    .replace(TRAILING_NOISE, '')
    .replace(TRAILING_NOISE, '')
    .replace(/[([{].*$/, '')
    .replace(/[.,;:!]+$/, '')
    .trim();
}

function plausibleTeam(s: string): boolean {
  // Team names: 2-40 characters, not a sentence, not just a number.
  return s.length >= 2 && s.length <= 40 && s.split(/\s+/).length <= 5 && /\p{L}/u.test(s);
}

/**
 * The match in a programme, or null. `category` is the programme's genre from
 * the guide; `group` and `channel` are the channel's category and name.
 */
export function detectMatch(
  title: string | undefined,
  category?: string,
  group?: string,
  channel?: string
): DetectedMatch | null {
  if (!title) return null;
  let text = title.replace(LIVE_MARKERS, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/^[-–:|\s]+/, '');

  // Peel "Competition: " prefixes; the teams are in the last part that has a separator.
  let competition: string | undefined;
  for (let i = 0; i < 3; i++) {
    const m = text.match(PREFIX_SPLIT);
    if (!m) break;
    const [, head, tail] = m;
    if (!SEPARATORS.some(([re]) => re.test(tail))) break;
    competition = competition ? `${competition} ${head}` : head;
    text = tail;
  }
  // "Arsenal v Chelsea - Premier League": drop a trailing competition.
  const tailSplit = text.match(/^(.+?\s+(?:v|vs\.?|x|@)\s+.+?)\s+[-–|]\s+(.{3,60})$/i);
  if (tailSplit) {
    text = tailSplit[1];
    competition ??= tailSplit[2];
  }

  for (const [re, swapped] of SEPARATORS) {
    const parts = text.split(re);
    if (parts.length !== 2) continue;
    const a = cleanTeam(parts[0]);
    const b = cleanTeam(parts[1]);
    if (!plausibleTeam(a) || !plausibleTeam(b)) continue;
    // A dash is too common in titles to trust without a strong signal.
    const weakSeparator = re.source.includes('[-–]');
    const sport = sportOf(competition, title, category, weakSeparator ? undefined : group, channel);
    if (!sport) return null;
    const [home, away] = swapped ? [b, a] : [a, b];
    return { sport, home, away, competition: competition?.trim() };
  }
  return null;
}

/** A stable key for one detected match on one day (cache and request dedupe). */
export function matchKey(m: DetectedMatch, date: string): string {
  return `${m.sport}|${m.home.toLowerCase()}|${m.away.toLowerCase()}|${date}`;
}
