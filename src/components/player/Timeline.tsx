import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { formatDuration, playerSeek, timelineOf } from '../../lib/player';
import {
  eventKind,
  eventWallTime,
  parseScore,
  runningScores,
  streamPosition,
  TIMELINE_KINDS,
  type EventKind,
  type SportsMatch,
  type TeamRef,
} from '../../lib/sports';
import { usePlayerUi } from '../../stores/player-ui-store';
import { EventIcon, EVENT_LABELS, TeamLogo } from '../sports/MatchView';

interface Marker {
  pos: number;
  kind: EventKind;
  minute: string;
  player?: string | null;
  assist?: string | null;
  team?: TeamRef;
  score?: [number, number];
}

const wallFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * The seek bar. Live channels: the rewind buffer up to the live edge, with
 * the match's goals and cards placed where they happened (TOD-style marks
 * with a card on hover); click a mark to watch the moment from just before
 * it. Files: start to end.
 */
export const Timeline = memo(function Timeline({
  live,
  match,
  delaySecs,
  onActivity,
}: {
  live: boolean;
  match: SportsMatch | null;
  delaySecs: number;
  /** Any interaction keeps the controls on screen. */
  onActivity: () => void;
}) {
  const mpv = usePlayerUi((s) => s.mpv);
  const tl = timelineOf(mpv, live);
  const span = Math.max(tl.end - tl.start, 0.001);
  const pct = (p: number) => `${((p - tl.start) / span) * 100}%`;
  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; pos: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  // Event marks: only on live streams, only inside the buffer.
  const now = Date.now();
  const markers = useMemo<Marker[]>(() => {
    if (!live || !match?.events?.length || !match.date) return [];
    const kickoff = Date.parse(match.date);
    if (!Number.isFinite(kickoff)) return [];
    const scores = runningScores(
      match.events,
      match.homeTeam,
      parseScore(match.state?.score?.current)
    );
    const out: Marker[] = [];
    match.events.forEach((e, i) => {
      const kind = eventKind(e.type);
      if (!TIMELINE_KINDS.includes(kind)) return;
      const pos = streamPosition(eventWallTime(kickoff, e.time), now, tl.end, tl.start, delaySecs);
      if (pos === null) return;
      out.push({
        pos,
        kind,
        minute: e.time,
        player: e.player,
        assist: e.assist,
        team: e.team,
        score: scores[i],
      });
    });
    return out;
    // Recomputed as the buffer moves (tl.end), not on every millisecond.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, match, delaySecs, Math.round(tl.end), Math.round(tl.start)]);

  const posAt = useCallback(
    (clientX: number) => {
      const r = barRef.current!.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return { x: f * r.width, pos: tl.start + f * span };
    },
    [tl.start, span]
  );

  const near = hover
    ? markers.find(
        (m) =>
          Math.abs(((m.pos - tl.start) / span) * (barRef.current?.clientWidth ?? 0) - hover.x) < 8
      )
    : undefined;

  const seekTo = (pos: number) => {
    playerSeek(pos, 'absolute').catch(() => {});
  };

  const shownPos = drag ?? tl.pos;
  const disabled = !tl.seekable;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={barRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={live ? 'Rewind buffer' : 'Seek'}
        aria-valuemin={0}
        aria-valuemax={Math.round(span)}
        aria-valuenow={Math.round(shownPos - tl.start)}
        aria-valuetext={
          live ? `${formatDuration(-(tl.end - shownPos))} behind live` : formatDuration(shownPos)
        }
        aria-disabled={disabled}
        onPointerMove={(e) => {
          onActivity();
          const h = posAt(e.clientX);
          setHover(h);
          if (drag !== null) setDrag(h.pos);
        }}
        onPointerLeave={() => drag === null && setHover(null)}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(posAt(e.clientX).pos);
        }}
        onPointerUp={(e) => {
          if (drag === null) return;
          // A press on a mark starts just before the moment.
          const target = near ? Math.max(tl.start, near.pos - 5) : posAt(e.clientX).pos;
          seekTo(target);
          setDrag(null);
        }}
        className={`group relative h-6 touch-none outline-none ${disabled ? 'cursor-default' : 'cursor-pointer'} focus-visible:ring-2 focus-visible:ring-accent`}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25 transition-[height] group-hover:h-1.5">
          <div
            // No width transition: easing between the 4 Hz updates kept the
            // transparent page repainting nonstop over the video.
            className="absolute inset-y-0 left-0 rounded-full bg-accent"
            style={{ width: pct(shownPos) }}
          />
          {hover && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/20"
              style={{ width: hover.x }}
            />
          )}
        </div>
        {markers.map((m, i) => (
          <span
            key={i}
            className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-black/40 ${
              m.kind === 'red' || m.kind === 'second-yellow'
                ? 'h-3 w-2 rounded-[2px] bg-[#E5322D]'
                : m.kind === 'yellow'
                  ? 'h-3 w-2 rounded-[2px] bg-[#F5C518]'
                  : m.kind === 'missed-penalty' || m.kind === 'var'
                    ? 'h-2.5 w-2.5 bg-white/70'
                    : 'h-3.5 w-3.5 bg-white'
            }`}
            style={{ left: pct(m.pos) }}
          />
        ))}
        <span
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-accent shadow transition-transform group-hover:scale-100"
          style={{ left: pct(shownPos) }}
        />

        {hover && (
          <div
            className="pointer-events-none absolute bottom-full mb-3 -translate-x-1/2"
            style={{
              left: Math.min(Math.max(hover.x, 110), (barRef.current?.clientWidth ?? 0) - 110),
            }}
          >
            {near ? (
              <MarkerCard m={near} />
            ) : (
              <span className="whitespace-nowrap rounded-md bg-black/85 px-2 py-1 text-xs font-semibold tabular-nums text-white">
                {live
                  ? `${formatDuration(-(tl.end - hover.pos))} · ${wallFormat.format(
                      now - delaySecs * 1000 - (tl.end - hover.pos) * 1000
                    )}`
                  : formatDuration(hover.pos)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function MarkerCard({ m }: { m: Marker }) {
  return (
    <div className="flex w-[220px] items-center gap-3 rounded-xl bg-black/90 p-3 text-white shadow-2xl ring-1 ring-white/10">
      <div className="flex flex-col items-center gap-1">
        <EventIcon kind={m.kind} size={20} />
        <span className="text-xs font-bold tabular-nums">{m.minute}'</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
          {EVENT_LABELS[m.kind]}
        </p>
        <p className="truncate text-sm font-semibold">{m.player ?? m.team?.name ?? ''}</p>
        {m.assist && <p className="truncate text-xs text-white/60">Assist: {m.assist}</p>}
        {(m.kind === 'goal' || m.kind === 'penalty' || m.kind === 'own-goal') && m.score && (
          <p className="text-xs font-bold text-accent">
            {m.score[0]} – {m.score[1]}
          </p>
        )}
      </div>
      {m.team && <TeamLogo src={m.team.logo} name={m.team.name} size={28} />}
    </div>
  );
}
