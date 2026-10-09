import { memo, useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, ExternalLink, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  eventKind,
  eventMinute,
  externalLinks,
  LINEUP_SPORTS,
  parseScore,
  runningScores,
  SPORT_LABELS,
  type EventKind,
  type LineupPlayer,
  type LineupTeam,
  type MatchEvent,
  type SportsMatch,
  type TeamStats,
} from '../../lib/sports';
import type { DetectedMatch } from '../../lib/matchDetect';
import type { MatchEntry } from '../../hooks/useMatchData';
import type { SportsQuota } from '../../lib/sports';
import { logger } from '../../lib/logger';

const open = (url: string) => openUrl(url).catch((err) => logger.warn('Failed to open link:', err));

// ---------- Small pieces ----------

export function TeamLogo({
  src,
  name,
  size = 40,
}: {
  src?: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-display font-bold text-text-muted"
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  );
}

/** The glyph for a match event: card colours, a ball, swap arrows. */
export function EventIcon({ kind, size = 16 }: { kind: EventKind; size?: number }) {
  const card = (color: string, offset = false) => (
    <span
      className="inline-block rounded-[2px] shadow-sm"
      style={{
        width: size * 0.62,
        height: size * 0.85,
        background: color,
        transform: offset ? 'translate(-35%, 10%) rotate(8deg)' : 'rotate(8deg)',
      }}
    />
  );
  switch (kind) {
    case 'goal':
    case 'penalty':
      return (
        <span role="img" aria-label={kind} style={{ fontSize: size * 0.95, lineHeight: 1 }}>
          ⚽
        </span>
      );
    case 'own-goal':
      return (
        <span
          role="img"
          aria-label="own goal"
          className="relative"
          style={{ fontSize: size * 0.95, lineHeight: 1 }}
        >
          ⚽<span className="absolute -right-1 -top-1 text-[9px] font-bold text-danger">OG</span>
        </span>
      );
    case 'missed-penalty':
      return (
        <span
          role="img"
          aria-label="missed penalty"
          className="relative opacity-60"
          style={{ fontSize: size * 0.95, lineHeight: 1 }}
        >
          ⚽
          <span className="absolute inset-0 flex items-center justify-center font-bold text-danger">
            ✕
          </span>
        </span>
      );
    case 'yellow':
      return card('#F5C518');
    case 'red':
      return card('#E5322D');
    case 'second-yellow':
      return (
        <span className="relative inline-flex">
          {card('#F5C518')}
          {card('#E5322D', true)}
        </span>
      );
    case 'sub':
      return (
        <ArrowLeftRight
          className="text-success"
          style={{ width: size, height: size }}
          aria-label="substitution"
        />
      );
    case 'var':
      return <span className="rounded bg-text/15 px-1 text-[10px] font-bold text-text">VAR</span>;
    default:
      return <span className="inline-block h-2 w-2 rounded-full bg-text-faint" />;
  }
}

export const EVENT_LABELS: Record<EventKind, string> = {
  goal: 'Goal',
  'own-goal': 'Own goal',
  penalty: 'Penalty goal',
  'missed-penalty': 'Missed penalty',
  yellow: 'Yellow card',
  'second-yellow': 'Second yellow',
  red: 'Red card',
  sub: 'Substitution',
  var: 'VAR',
  other: 'Event',
};

function LiveDot() {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
    </span>
  );
}

function stateLine(m: SportsMatch): { text: string; live: boolean } {
  const d = m.state?.description ?? '';
  const clock = m.state?.clock;
  const lower = d.toLowerCase();
  const live =
    !!d && !/finished|not started|announced|postponed|cancel|half time|break/.test(lower);
  if (lower.includes('not started') || lower.includes('announced')) {
    const t = new Date(m.date);
    return {
      text: `Kick-off ${t.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`,
      live: false,
    };
  }
  return { text: live && clock ? `${d} · ${clock}'` : d, live };
}

// ---------- Scoreboard ----------

export const Scoreboard = memo(function Scoreboard({
  match,
  compact = false,
}: {
  match: SportsMatch;
  compact?: boolean;
}) {
  const score = parseScore(match.state?.score?.current);
  const pens = match.state?.score?.penalties;
  const { text, live } = stateLine(match);
  const logo = compact ? 36 : 56;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        {match.league?.logo && (
          <TeamLogo src={match.league.logo} name={match.league.name ?? ''} size={16} />
        )}
        <span className="truncate">
          {[match.league?.name, match.round].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex min-w-0 flex-col items-center gap-2 text-center">
          <TeamLogo src={match.homeTeam.logo} name={match.homeTeam.name} size={logo} />
          <span
            className={`line-clamp-2 font-semibold text-text ${compact ? 'text-sm' : 'text-base'}`}
          >
            {match.homeTeam.name}
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span
            className={`font-display font-bold tabular-nums text-text ${compact ? 'text-3xl' : 'text-5xl'}`}
          >
            {score ? `${score[0]} – ${score[1]}` : 'vs'}
          </span>
          {pens && <span className="text-xs text-text-muted">Pens {pens}</span>}
        </div>
        <div className="flex min-w-0 flex-col items-center gap-2 text-center">
          <TeamLogo src={match.awayTeam.logo} name={match.awayTeam.name} size={logo} />
          <span
            className={`line-clamp-2 font-semibold text-text ${compact ? 'text-sm' : 'text-base'}`}
          >
            {match.awayTeam.name}
          </span>
        </div>
      </div>
      {text && (
        <span
          className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
            live ? 'bg-danger/15 text-danger' : 'bg-text/10 text-text-muted'
          }`}
        >
          {live && <LiveDot />}
          {text}
        </span>
      )}
    </div>
  );
});

// ---------- Tabs ----------

/** A 0–90' strip with the match's key events, like a sports app's momentum bar. */
function MatchStrip({ match }: { match: SportsMatch }) {
  const events = (match.events ?? []).filter((e) => eventKind(e.type) !== 'sub');
  const clock = Math.min(match.state?.clock ?? 0, 120);
  const span = Math.max(90, ...events.map((e) => eventMinute(e.time)), clock);
  const isHome = (e: MatchEvent) => e.team?.name === match.homeTeam.name;
  return (
    <div className="relative h-14 select-none" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-text/10" />
      {clock > 0 && (
        <div
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent/70"
          style={{ width: `${(clock / span) * 100}%` }}
        />
      )}
      <div
        className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-text/30"
        style={{ left: `${(45 / span) * 100}%` }}
      />
      {events.map((e, i) => (
        <div
          key={i}
          className="absolute -translate-x-1/2"
          style={{
            left: `${(Math.min(eventMinute(e.time), span) / span) * 100}%`,
            top: isHome(e) ? 0 : 'auto',
            bottom: isHome(e) ? 'auto' : 0,
          }}
          title={`${e.time}' ${EVENT_LABELS[eventKind(e.type)]}${e.player ? ` – ${e.player}` : ''}`}
        >
          <EventIcon kind={eventKind(e.type)} size={14} />
        </div>
      ))}
      <span className="absolute -bottom-1 left-0 text-[10px] text-text-faint">0'</span>
      <span
        className="absolute -bottom-1 text-[10px] text-text-faint"
        style={{ left: `${(45 / span) * 100}%` }}
      >
        HT
      </span>
      <span className="absolute -bottom-1 right-0 text-[10px] text-text-faint">{span}'</span>
    </div>
  );
}

function EventsTab({ match }: { match: SportsMatch }) {
  const events = useMemo(() => match.events ?? [], [match.events]);
  const current = match.state?.score?.current;
  const scores = useMemo(
    () => runningScores(events, match.homeTeam, parseScore(current)),
    [events, match.homeTeam, current]
  );
  if (events.length === 0) {
    return <Empty text="No events yet. They appear here as the match goes on." />;
  }
  const rows = events.map((e, i) => ({ e, score: scores[i], i })).reverse();
  return (
    <div className="flex flex-col gap-4">
      <MatchStrip match={match} />
      <ol className="flex flex-col">
        {rows.map(({ e, score, i }) => {
          const kind = eventKind(e.type);
          const home = e.team?.name === match.homeTeam.name;
          const scoring = kind === 'goal' || kind === 'penalty' || kind === 'own-goal';
          return (
            <li
              key={i}
              className={`grid grid-cols-[1fr_3.5rem_1fr] items-center gap-2 border-b border-border/60 py-2 ${
                scoring ? 'bg-accent/5' : ''
              }`}
            >
              <div className="flex min-w-0 items-center justify-end gap-2 text-right">
                {home && (
                  <>
                    <EventText e={e} kind={kind} />
                    <EventIcon kind={kind} />
                  </>
                )}
              </div>
              <div className="flex flex-col items-center">
                <span className="text-xs font-bold tabular-nums text-text">{e.time}'</span>
                {scoring && (
                  <span className="text-[11px] font-bold tabular-nums text-accent-text">
                    {score[0]}–{score[1]}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-2">
                {!home && (
                  <>
                    <EventIcon kind={kind} />
                    <EventText e={e} kind={kind} />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EventText({ e, kind }: { e: MatchEvent; kind: EventKind }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-sm font-medium text-text">
        {kind === 'sub'
          ? (e.player ?? e.substituted ?? 'Substitution')
          : (e.player ?? EVENT_LABELS[kind])}
      </span>
      <span className="block truncate text-xs text-text-faint">
        {kind === 'sub' && e.substituted
          ? `for ${e.substituted}`
          : e.assist
            ? `Assist: ${e.assist}`
            : EVENT_LABELS[kind]}
      </span>
    </span>
  );
}

function statValue(name: string, v: number | string | null): string {
  if (v === null || v === undefined) return '–';
  if (
    typeof v === 'number' &&
    v > 0 &&
    v <= 1 &&
    /possession|accuracy|%|rate|percentage/i.test(name)
  ) {
    return `${Math.round(v * 100)}%`;
  }
  return String(v);
}

function StatsTab({ match }: { match: SportsMatch }) {
  const stats = match.statistics ?? [];
  const home = stats.find((s) => s.team?.name === match.homeTeam.name) ?? stats[0];
  const away = stats.find((s) => s !== home);
  if (!home || !away) return <Empty text="No statistics for this match yet." />;
  const byName = (t: TeamStats) => new Map(t.statistics.map((s) => [s.displayName, s.value]));
  const hm = byName(home);
  const am = byName(away);
  const names = home.statistics.map((s) => s.displayName).filter((n) => am.has(n));
  return (
    <ul className="flex flex-col gap-3">
      {names.map((n) => {
        const hv = hm.get(n) ?? null;
        const av = am.get(n) ?? null;
        const hn = typeof hv === 'number' ? hv : parseFloat(String(hv));
        const an = typeof av === 'number' ? av : parseFloat(String(av));
        const total = (hn || 0) + (an || 0);
        const hp = total > 0 ? ((hn || 0) / total) * 100 : 50;
        return (
          <li key={n} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-sm">
              <span
                className={`tabular-nums ${hn > an ? 'font-bold text-text' : 'text-text-muted'}`}
              >
                {statValue(n, hv)}
              </span>
              <span className="text-xs text-text-muted">{n}</span>
              <span
                className={`tabular-nums ${an > hn ? 'font-bold text-text' : 'text-text-muted'}`}
              >
                {statValue(n, av)}
              </span>
            </div>
            <div className="flex h-1.5 gap-1">
              <div className="flex flex-1 justify-end overflow-hidden rounded-full bg-text/10">
                <div className="rounded-full bg-accent" style={{ width: `${hp}%` }} />
              </div>
              <div className="flex-1 overflow-hidden rounded-full bg-text/10">
                <div className="h-full rounded-full bg-text/60" style={{ width: `${100 - hp}%` }} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function flatLineup(l?: LineupTeam['initialLineup']): LineupPlayer[] {
  if (!l) return [];
  return (l as Array<LineupPlayer | LineupPlayer[]>).flatMap((x) => (Array.isArray(x) ? x : [x]));
}

function LineupColumn({ team }: { team?: LineupTeam }) {
  if (!team) return null;
  const starters = flatLineup(team.initialLineup);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <TeamLogo src={team.logo} name={team.name} size={24} />
        <span className="truncate font-semibold text-text">{team.name}</span>
        {team.formation && (
          <span className="ml-auto text-xs text-text-muted">{team.formation}</span>
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        {starters.map((p, i) => (
          <li key={`${p.name}-${i}`} className="flex gap-2 text-sm">
            <span className="w-6 text-right tabular-nums text-text-faint">{p.number ?? ''}</span>
            <span className="truncate text-text">{p.name}</span>
            <span className="ml-auto text-xs text-text-faint">{p.position?.charAt(0)}</span>
          </li>
        ))}
      </ul>
      {team.substitutes && team.substitutes.length > 0 && (
        <>
          <span className="mt-2 text-xs font-semibold uppercase tracking-wide text-text-faint">
            Bench
          </span>
          <ul className="flex flex-col gap-0.5">
            {team.substitutes.map((p, i) => (
              <li key={`${p.name}-${i}`} className="flex gap-2 text-sm text-text-muted">
                <span className="w-6 text-right tabular-nums text-text-faint">
                  {p.number ?? ''}
                </span>
                <span className="truncate">{p.name}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProbBar({
  label,
  p,
}: {
  label: string;
  p: { home?: string; draw?: string; away?: string };
}) {
  const n = (s?: string) => parseFloat(s ?? '0') || 0;
  const [h, d, a] = [n(p.home), n(p.draw), n(p.away)];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="flex h-6 overflow-hidden rounded-md text-[11px] font-bold text-white">
        {h > 0 && (
          <div
            className="flex items-center justify-center bg-accent text-on-accent"
            style={{ width: `${h}%` }}
          >
            {Math.round(h)}%
          </div>
        )}
        {d > 0 && (
          <div
            className="flex items-center justify-center bg-neutral-500"
            style={{ width: `${d}%` }}
          >
            {Math.round(d)}%
          </div>
        )}
        {a > 0 && (
          <div className="flex items-center justify-center bg-text/60" style={{ width: `${a}%` }}>
            {Math.round(a)}%
          </div>
        )}
      </div>
    </div>
  );
}

function InsightsTab({ match }: { match: SportsMatch }) {
  const pre = match.predictions?.prematch?.at(-1);
  const live = match.predictions?.live?.at(-1);
  const facts = [
    match.venue?.name && ['Venue', [match.venue.name, match.venue.city].filter(Boolean).join(', ')],
    match.venue?.capacity && ['Capacity', match.venue.capacity],
    match.referee?.name && [
      'Referee',
      [match.referee.name, match.referee.nationality].filter(Boolean).join(' · '),
    ],
    match.forecast?.status && [
      'Weather',
      [match.forecast.status, match.forecast.temperature].filter(Boolean).join(' · '),
    ],
    ['Kick-off', new Date(match.date).toLocaleString()],
  ].filter(Boolean) as Array<[string, string]>;
  const tops = [match.homeTeam, match.awayTeam].filter((t) => t.topPlayers?.length);
  return (
    <div className="flex flex-col gap-5">
      {(pre?.probabilities || live?.probabilities) && (
        <section className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-text">Win probability</h4>
          {live?.probabilities && <ProbBar label="Live" p={live.probabilities} />}
          {pre?.probabilities && <ProbBar label="Before kick-off" p={pre.probabilities} />}
          <div className="flex justify-between text-[11px] text-text-faint">
            <span>{match.homeTeam.name}</span>
            <span>Draw</span>
            <span>{match.awayTeam.name}</span>
          </div>
          {(live ?? pre)?.description && (
            <p className="text-sm text-text-muted">{(live ?? pre)!.description}</p>
          )}
        </section>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-faint">{k}</dt>
            <dd className="text-text">{v}</dd>
          </div>
        ))}
      </dl>
      {tops.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-text">Top players</h4>
          {tops.map((t) => (
            <div key={t.name} className="flex flex-col gap-1">
              <span className="text-xs text-text-muted">{t.name}</span>
              {t.topPlayers!.slice(0, 3).map((p) => (
                <div key={p.name} className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium text-text">{p.name}</span>
                  <span className="text-xs text-text-faint">{p.position}</span>
                  <span className="ml-auto truncate text-xs text-text-muted">
                    {(p.statistics ?? [])
                      .slice(0, 2)
                      .map((s) => `${s.name} ${String(s.value)}`)
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      {match.news && match.news.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-text">News</h4>
          {match.news.slice(0, 5).map((n) => (
            <button
              key={n.url}
              type="button"
              onClick={() => open(n.url)}
              className="flex items-center gap-3 rounded-lg p-1.5 text-left hover:bg-text/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {n.image && (
                <img
                  src={n.image}
                  alt=""
                  loading="lazy"
                  className="h-10 w-16 shrink-0 rounded object-cover"
                />
              )}
              <span className="line-clamp-2 text-sm text-text">{n.title}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-text-muted">{text}</p>;
}

function Spinner({ text }: { text: string }) {
  return (
    <p className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {text}
    </p>
  );
}

// ---------- The whole view ----------

type Tab = 'events' | 'stats' | 'lineups' | 'insights' | 'highlights';

export interface MatchViewProps {
  detected: DetectedMatch;
  entry: MatchEntry | undefined;
  match: SportsMatch | null;
  quota: SportsQuota | null;
  onRefresh: () => void;
  onLoadHighlights: () => void;
  onLoadLineups: () => void;
  /** Opens the Display panel where the API key goes. */
  onOpenSettings?: () => void;
  compact?: boolean;
}

export function MatchView({
  detected,
  entry,
  match,
  quota,
  onRefresh,
  onLoadHighlights,
  onLoadLineups,
  onOpenSettings,
  compact = false,
}: MatchViewProps) {
  const [tab, setTab] = useState<Tab>('events');
  const hasLineups = LINEUP_SPORTS.includes(detected.sport);
  useEffect(() => {
    if (tab === 'highlights') onLoadHighlights();
    if (tab === 'lineups') onLoadLineups();
  }, [tab, onLoadHighlights, onLoadLineups]);

  const links = externalLinks(detected.home, detected.away);
  const tabs: Array<[Tab, string]> = [
    ['events', 'Timeline'],
    ['stats', 'Stats'],
    ...(hasLineups ? ([['lineups', 'Line-ups']] as Array<[Tab, string]>) : []),
    ['insights', 'Insights'],
    ['highlights', 'Highlights'],
  ];

  let body: React.ReactNode;
  if (!entry || entry.status === 'finding') {
    body = <Spinner text={`Looking up ${detected.home} v ${detected.away}…`} />;
  } else if (entry.status === 'error') {
    const missingKey = /api key/i.test(entry.error ?? '');
    body = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-text-muted">{entry.error}</p>
        {missingKey && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/50"
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            Add API key
          </button>
        )}
      </div>
    );
  } else if (entry.status === 'none' || !match) {
    body = (
      <Empty
        text={`No ${SPORT_LABELS[detected.sport].toLowerCase()} match “${detected.home} v ${detected.away}” in the data today. The guide may spell the teams differently; try the links below.`}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <Scoreboard match={match} compact={compact} />
        <div
          role="tablist"
          aria-label="Match details"
          className="scrollbar-hide flex gap-1 overflow-x-auto border-b border-border"
        >
          {tabs.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                tab === t
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-muted hover:text-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'events' && <EventsTab match={match} />}
          {tab === 'stats' && <StatsTab match={match} />}
          {tab === 'insights' && <InsightsTab match={match} />}
          {tab === 'lineups' &&
            (entry.lineups.status === 'ok' ? (
              entry.lineups.data.homeTeam || entry.lineups.data.awayTeam ? (
                <div className="grid grid-cols-2 gap-4">
                  <LineupColumn team={entry.lineups.data.homeTeam} />
                  <LineupColumn team={entry.lineups.data.awayTeam} />
                </div>
              ) : (
                <Empty text="Line-ups are not out yet." />
              )
            ) : entry.lineups.status === 'error' ? (
              <Empty text={entry.lineups.error} />
            ) : (
              <Spinner text="Loading line-ups…" />
            ))}
          {tab === 'highlights' &&
            (entry.highlights.status === 'ok' ? (
              entry.highlights.data.length ? (
                <div className={`grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {entry.highlights.data.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => open(h.url)}
                      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-surface text-left outline-none hover:border-border-strong focus-visible:ring-4 focus-visible:ring-accent"
                    >
                      <div className="relative aspect-video bg-surface-2">
                        {h.imgUrl && (
                          <img
                            src={h.imgUrl}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        )}
                        <ExternalLink
                          className="absolute right-2 top-2 h-4 w-4 text-white drop-shadow"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="flex flex-col gap-0.5 p-2.5">
                        <span className="line-clamp-2 text-sm font-medium text-text">
                          {h.title}
                        </span>
                        <span className="text-xs text-text-faint">
                          {[h.source, h.channel].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty text="No highlights yet. Clips usually arrive during or soon after the match." />
              )
            ) : entry.highlights.status === 'error' ? (
              <Empty text={entry.highlights.error} />
            ) : (
              <Spinner text="Loading highlights…" />
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {body}
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <button
            key={l.label}
            type="button"
            onClick={() => open(l.url)}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-muted outline-none hover:bg-text/5 focus-visible:ring-2 focus-visible:ring-accent"
          >
            {l.label}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-text-faint">
        <span>
          Data: Highlightly
          {quota && quota.remaining >= 0
            ? ` · ${quota.remaining}/${quota.limit} requests left today`
            : ''}
          {entry?.updatedAt ? ` · updated ${new Date(entry.updatedAt).toLocaleTimeString()}` : ''}
        </span>
        {entry?.status === 'found' && (
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh match data"
            className="rounded-full p-1.5 outline-none hover:bg-text/10 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
