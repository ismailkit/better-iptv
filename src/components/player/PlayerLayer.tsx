import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AudioLines,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Loader2,
  Maximize,
  Maximize2,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Radio,
  RotateCcw,
  RotateCw,
  Subtitles,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { VideoSurface } from './VideoSurface';
import { Timeline } from './Timeline';
import { MatchView } from '../sports/MatchView';
import {
  formatDuration,
  playerFrameStep,
  playerSeek,
  playerSet,
  timelineOf,
  trackLabel,
  type MpvTrack,
} from '../../lib/player';
import { formatClock, progressPercent } from '../../lib/epgTime';
import { parseScore, matchPhase } from '../../lib/sports';
import { usePlayerUi } from '../../stores/player-ui-store';
import { MINI_WIDTHS, useDisplayStore } from '../../stores/display-store';
import { useMatchData, detectChannelMatch } from '../../hooks/useMatchData';
import type { EpgEntry } from '../../stores/player-store';
import type { Channel } from '../../types';
import { logger } from '../../lib/logger';

interface PlayerLayerProps {
  channel: Channel;
  epg?: EpgEntry;
  onStop: () => void;
  /** Play the previous (-1) or next (+1) channel of the list being browsed. */
  onZap: (delta: -1 | 1) => void;
  onOpenSettings: () => void;
}

const set = (name: string, value: boolean | number | string) =>
  playerSet(name, value).catch((err) => logger.warn(`Player: set ${name} failed`, err));
const seek = (value: number, mode: Parameters<typeof playerSeek>[1] = 'relative') =>
  playerSeek(value, mode).catch(() => {});

async function setFullscreen(on: boolean) {
  try {
    await getCurrentWindow().setFullscreen(on);
    usePlayerUi.getState().setFullscreen(on);
  } catch (err) {
    logger.warn('Fullscreen failed:', err);
  }
}

/**
 * The in-app player, drawn over everything in its own layer: a mini player
 * in a corner while browsing, or the full player. Rendered only while the
 * embedded player is playing (see MainScreen).
 */
export function PlayerLayer(props: PlayerLayerProps) {
  const mode = usePlayerUi((s) => s.mode);
  // Leaving the full player always leaves fullscreen too.
  useEffect(() => {
    if (mode === 'mini' && usePlayerUi.getState().fullscreen) void setFullscreen(false);
  }, [mode]);
  useEffect(
    () => () => {
      if (usePlayerUi.getState().fullscreen) void setFullscreen(false);
    },
    []
  );
  return createPortal(
    mode === 'full' ? <FullPlayer {...props} /> : <MiniPlayer {...props} />,
    document.body
  );
}

// ---------- Shared bits ----------

function useBuffering() {
  return usePlayerUi((s) => Boolean(s.mpv.loading || s.mpv['paused-for-cache']) && !s.mpv.error);
}

/**
 * Centred by a flex box, not by translate: animate-spin's keyframes set
 * `transform` too, and mixing the two made the icon slide instead of turn.
 */
function BufferingSpinner({ className }: { className: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <Loader2 className={`animate-spin text-white/90 ${className}`} aria-label="Buffering" />
    </div>
  );
}

function AgeTag({ age }: { age?: number }) {
  const min = useDisplayStore((s) => (s.ageTags ? s.ageTagMin : Infinity));
  if (age === undefined || age < min) return null;
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-xs font-bold leading-none text-white ${
        age >= 18 ? 'bg-red-600' : 'bg-neutral-500'
      }`}
    >
      +{age}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  active,
  className = '',
  ...rest
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<globalThis.HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-accent ${
        active ? 'bg-white/15 text-accent' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- Mini player ----------

/** Pointer travel (px) before a press on the mini player becomes a drag. */
const DRAG_SLOP = 5;

/**
 * Drag the mini player anywhere in the window. A press that moves less
 * than DRAG_SLOP stays a click (opens the full player, presses a button);
 * a real drag swallows the click that follows it. The spot is kept in the
 * display settings and pulled back inside the window when it shrinks.
 */
function useMiniDrag(width: number) {
  const saved = useDisplayStore((s) => s.miniPos);
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const [, setViewport] = useState(0);
  const press = useRef<{
    id: number;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const swallowClick = useRef(false);

  // Re-clamp a saved spot when the window resizes.
  useEffect(() => {
    if (!saved) return;
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [saved]);

  const clamp = (p: { x: number; y: number }) => {
    const h = (width * 9) / 16;
    const m = 8;
    return {
      x: Math.round(Math.min(Math.max(m, p.x), Math.max(m, window.innerWidth - width - m))),
      y: Math.round(Math.min(Math.max(m, p.y), Math.max(m, window.innerHeight - h - m))),
    };
  };

  const raw = live ?? saved;
  const pos = raw ? clamp(raw) : null;

  const dragHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      swallowClick.current = false;
      const r = e.currentTarget.getBoundingClientRect();
      press.current = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        ox: r.left,
        oy: r.top,
        moved: false,
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      const dx = e.clientX - p.sx;
      const dy = e.clientY - p.sy;
      if (!p.moved) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        p.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setLive({ x: p.ox + dx, y: p.oy + dy });
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      const p = press.current;
      press.current = null;
      if (!p?.moved) return;
      swallowClick.current = true;
      const final = clamp({ x: p.ox + e.clientX - p.sx, y: p.oy + e.clientY - p.sy });
      useDisplayStore.getState().set({ miniPos: final });
      setLive(null);
    },
    onPointerCancel: () => {
      press.current = null;
      setLive(null);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return { pos, dragging: live !== null, dragHandlers };
}

function MiniPlayer({ channel, epg, onStop }: PlayerLayerProps) {
  const size = useDisplayStore((s) => s.miniSize);
  const corner = useDisplayStore((s) => s.miniCorner);
  const pause = usePlayerUi((s) => s.mpv.pause ?? false);
  const mute = usePlayerUi((s) => s.mpv.mute ?? false);
  const buffering = useBuffering();
  const setMode = usePlayerUi((s) => s.setMode);
  const width = MINI_WIDTHS[size];
  const detected = detectChannelMatch(channel, epg);
  // The score only if something already fetched it: the mini player never
  // spends API requests on its own.
  const start = epg?.currentStart ? Date.parse(epg.currentStart) : undefined;
  const { match } = useMatchData(detected, start, false);
  const score = parseScore(match?.state?.score?.current);
  const pct =
    epg?.currentStart && epg?.currentEnd ? progressPercent(epg.currentStart, epg.currentEnd) : null;

  const { pos, dragging, dragHandlers } = useMiniDrag(width);

  const place: React.CSSProperties = pos
    ? { width, left: pos.x, top: pos.y }
    : {
        width,
        // Below the top bar and the section header (search, Display button).
        ...(corner.startsWith('top') ? { top: 144 } : { bottom: 24 }),
        ...(corner.endsWith('right') ? { right: 24 } : { left: 96 }),
      };

  return (
    <div
      className={`group fixed z-[45] touch-none overflow-hidden rounded-xl shadow-[0_12px_40px_rgba(0,0,0,.55)] ring-1 ring-white/10 ${
        dragging ? 'cursor-grabbing' : ''
      }`}
      style={place}
      role="region"
      aria-label={`Now playing: ${channel.name}`}
      {...dragHandlers}
    >
      <div className="relative aspect-video">
        <VideoSurface
          full={false}
          layoutKey={pos ? `${pos.x},${pos.y},${size}` : `${corner}-${size}`}
          className="absolute inset-0"
        />
        {/* The picture itself opens the full player. */}
        <button
          type="button"
          aria-label={`Open the player for ${channel.name}`}
          onClick={() => setMode('full')}
          className="absolute inset-0 outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-accent"
        />
        {buffering && <BufferingSpinner className="h-8 w-8" />}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-black/75 to-transparent p-2.5 pb-6 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{channel.name}</p>
            {epg?.current && <p className="truncate text-xs text-white/75">{epg.current}</p>}
          </div>
          <AgeTag age={epg?.currentAge} />
        </div>
        {score && match && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/80 px-2 py-0.5 text-xs font-bold text-white group-hover:opacity-0">
            {match.homeTeam.name.slice(0, 3).toUpperCase()} {score[0]}–{score[1]}{' '}
            {match.awayTeam.name.slice(0, 3).toUpperCase()}
          </span>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1.5 pt-6 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label={pause ? 'Play' : 'Pause'} onClick={() => set('pause', !pause)}>
            {pause ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
          </IconButton>
          <IconButton label={mute ? 'Unmute' : 'Mute'} onClick={() => set('mute', !mute)}>
            {mute ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </IconButton>
          <div className="flex-1" />
          <IconButton label="Open player" onClick={() => setMode('full')}>
            <Maximize2 className="h-5 w-5" />
          </IconButton>
          <IconButton label="Stop" onClick={onStop}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        {pct !== null && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/15">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Full player ----------

const HIDE_AFTER_MS = 3000;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function FullPlayer({ channel, epg, onStop, onZap, onOpenSettings }: PlayerLayerProps) {
  const setMode = usePlayerUi((s) => s.setMode);
  const fullscreen = usePlayerUi((s) => s.fullscreen);
  const insightsOpen = usePlayerUi((s) => s.insightsOpen);
  const setInsightsOpen = usePlayerUi((s) => s.setInsightsOpen);
  const pause = usePlayerUi((s) => s.mpv.pause ?? false);
  const buffering = useBuffering();
  const delaySecs = useDisplayStore((s) => s.sportsDelaySecs);
  const live = channel.content_type === 'live';

  const detected = detectChannelMatch(channel, epg);
  const start = epg?.currentStart ? Date.parse(epg.currentStart) : undefined;
  // The full player is where match data is worth the requests: the
  // timeline marks and the insights panel both need it.
  const matchData = useMatchData(detected, start, Boolean(detected));
  const score = parseScore(matchData.match?.state?.score?.current);
  const phase = matchPhase(matchData.match);

  // Controls show on any activity and hide after a few idle seconds.
  const [visible, setVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef<number>(0);
  const wake = useCallback(() => {
    setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);
  const shown = visible || pause || menuOpen;

  const toggleFullscreen = useCallback(() => {
    void setFullscreen(!usePlayerUi.getState().fullscreen);
  }, []);

  // Keyboard: the player owns the keys while it is open (captured before the
  // app's shortcuts and arrow navigation). Dialogs above it keep theirs.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const t = e.target as HTMLElement;
      if (t instanceof globalThis.HTMLInputElement && t.type !== 'range') return;
      const s = usePlayerUi.getState();
      const tl = timelineOf(s.mpv, live);
      let handled = true;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          set('pause', !(s.mpv.pause ?? false));
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          seek(e.shiftKey ? -60 : -10);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          seek(e.shiftKey ? 60 : 10);
          break;
        case 'ArrowUp':
          set('volume', Math.min(130, (s.mpv.volume ?? 100) + 5));
          break;
        case 'ArrowDown':
          set('volume', Math.max(0, (s.mpv.volume ?? 100) - 5));
          break;
        case 'm':
        case 'M':
          set('mute', !(s.mpv.mute ?? false));
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'i':
        case 'I':
          if (detected) s.setInsightsOpen(!s.insightsOpen);
          break;
        case ',':
          void playerFrameStep(true);
          break;
        case '.':
          void playerFrameStep(false);
          break;
        case 'Home':
          if (tl.seekable) seek(tl.start, 'absolute');
          break;
        case 'End':
          if (tl.live) seek(Math.max(tl.start, tl.end - 1), 'absolute');
          break;
        case 'PageUp':
          onZap(-1);
          break;
        case 'PageDown':
          onZap(1);
          break;
        case 'c':
        case 'C': {
          const sid = s.mpv.sid;
          set('sid', sid === false || sid === 'no' || sid === undefined ? 'auto' : 'no');
          break;
        }
        case 'Escape':
          if (s.fullscreen) void setFullscreen(false);
          else s.setMode('mini');
          break;
        case 'Backspace':
          s.setMode('mini');
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        wake();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [live, detected, onZap, toggleFullscreen, wake]);

  const pct =
    epg?.currentStart && epg?.currentEnd ? progressPercent(epg.currentStart, epg.currentEnd) : null;

  return (
    <div
      className={`fixed inset-0 z-[60] flex text-white ${shown ? '' : 'cursor-none'}`}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <div className="relative min-w-0 flex-1">
        <VideoSurface full className="absolute inset-0" />

        {/* Click toggles pause, double-click toggles fullscreen. */}
        <div
          className="absolute inset-0"
          onClick={() => set('pause', !usePlayerUi.getState().mpv.pause)}
          onDoubleClick={toggleFullscreen}
          aria-hidden="true"
        />

        {buffering && <BufferingSpinner className="h-14 w-14" />}
        {pause && !buffering && (
          <button
            type="button"
            aria-label="Play"
            onClick={() => set('pause', false)}
            className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white outline-none ring-1 ring-white/20 backdrop-blur-sm focus-visible:ring-4 focus-visible:ring-accent"
          >
            <Play className="ml-1 h-9 w-9" />
          </button>
        )}

        {/* Top strip */}
        <div
          className={`absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 pb-10 pt-4 transition-opacity duration-300 ${
            shown ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <IconButton label="Back to browsing (Esc)" onClick={() => setMode('mini')}>
            <ChevronDown className="h-6 w-6" />
          </IconButton>
          {channel.logo && (
            <img
              src={channel.logo}
              alt=""
              className="h-9 w-14 shrink-0 object-contain"
              draggable={false}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-xl font-semibold">{channel.name}</h2>
              <AgeTag age={epg?.currentAge} />
            </div>
            {epg?.current && (
              <div className="flex items-center gap-3 text-sm text-white/80">
                <span className="truncate">{epg.current}</span>
                {epg.currentStart && epg.currentEnd && (
                  <span className="shrink-0 tabular-nums text-white/60">
                    {formatClock(epg.currentStart)}–{formatClock(epg.currentEnd)}
                  </span>
                )}
                {pct !== null && (
                  <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-white/20">
                    <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
                  </span>
                )}
              </div>
            )}
          </div>
          {detected && matchData.match && (
            <button
              type="button"
              onClick={() => setInsightsOpen(!insightsOpen)}
              className="flex shrink-0 items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-sm font-bold outline-none ring-1 ring-white/15 hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-accent"
            >
              {phase === 'live' && (
                <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
              )}
              <span className="max-w-[9rem] truncate">{matchData.match.homeTeam.name}</span>
              <span className="tabular-nums text-accent">
                {score ? `${score[0]} – ${score[1]}` : 'vs'}
              </span>
              <span className="max-w-[9rem] truncate">{matchData.match.awayTeam.name}</span>
              {matchData.match.state?.clock ? (
                <span className="font-normal text-white/70">{matchData.match.state.clock}'</span>
              ) : null}
            </button>
          )}
          <IconButton label="Previous channel (PgUp)" onClick={() => onZap(-1)}>
            <ChevronLeft className="h-5 w-5" />
          </IconButton>
          <IconButton label="Next channel (PgDn)" onClick={() => onZap(1)}>
            <ChevronRight className="h-5 w-5" />
          </IconButton>
          <IconButton label="Stop" onClick={onStop}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>

        {/* Bottom controls */}
        <div
          className={`absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-5 pb-4 pt-16 transition-opacity duration-300 ${
            shown ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          <Timeline live={live} match={matchData.match} delaySecs={delaySecs} onActivity={wake} />
          <ControlBar
            live={live}
            hasMatch={Boolean(detected)}
            insightsOpen={insightsOpen}
            onToggleInsights={() => setInsightsOpen(!insightsOpen)}
            fullscreen={fullscreen}
            onToggleFullscreen={toggleFullscreen}
            onMinimize={() => setMode('mini')}
            onMenuOpenChange={setMenuOpen}
          />
        </div>
      </div>

      {detected && insightsOpen && (
        <aside
          className="flex w-[min(420px,40vw)] shrink-0 flex-col border-l border-border bg-bg text-text"
          aria-label="Match insights"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="font-display text-lg font-semibold">Match centre</h3>
            <button
              type="button"
              aria-label="Close match centre (I)"
              onClick={() => setInsightsOpen(false)}
              className="rounded-full p-1.5 text-text-muted outline-none hover:bg-text/10 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <MatchView
              compact
              detected={detected}
              entry={matchData.entry}
              match={matchData.match}
              quota={matchData.quota}
              onRefresh={matchData.refresh}
              onLoadHighlights={matchData.loadHighlights}
              onLoadLineups={matchData.loadLineups}
              onOpenSettings={onOpenSettings}
            />
          </div>
        </aside>
      )}
    </div>
  );
}

// ---------- Control bar ----------

const ControlBar = memo(function ControlBar({
  live,
  hasMatch,
  insightsOpen,
  onToggleInsights,
  fullscreen,
  onToggleFullscreen,
  onMinimize,
  onMenuOpenChange,
}: {
  live: boolean;
  hasMatch: boolean;
  insightsOpen: boolean;
  onToggleInsights: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onMinimize: () => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const mpv = usePlayerUi((s) => s.mpv);
  const tl = timelineOf(mpv, live);
  const pause = mpv.pause ?? false;
  const volume = mpv.volume ?? 100;
  const mute = mpv.mute ?? false;
  const tracks = mpv['track-list'] ?? [];
  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'sub');
  const atLive = tl.live && tl.behind < 8;

  // Hold rewind to scan back through the buffer (about 25x speed).
  const scan = useRef<{ wait: number; tick: number }>({ wait: 0, tick: 0 });
  const startScan = (dir: -1 | 1) => {
    seek(dir * 10);
    scan.current.wait = window.setTimeout(() => {
      scan.current.tick = window.setInterval(() => seek(dir * 5), 200);
    }, 450);
  };
  const stopScan = () => {
    window.clearTimeout(scan.current.wait);
    window.clearInterval(scan.current.tick);
  };
  useEffect(() => stopScan, []);

  return (
    <div className="flex items-center gap-1">
      <IconButton
        label={pause ? 'Play (Space)' : 'Pause (Space)'}
        onClick={() => set('pause', !pause)}
      >
        {pause ? <Play className="h-6 w-6" /> : <Pause className="h-6 w-6" />}
      </IconButton>
      <IconButton
        label="Back 10 s, hold to rewind (J / ←)"
        disabled={!tl.seekable}
        onPointerDown={() => tl.seekable && startScan(-1)}
        onPointerUp={stopScan}
        onPointerLeave={stopScan}
        onKeyDown={(e) => e.key === 'Enter' && seek(-10)}
        className="disabled:opacity-40"
      >
        <RotateCcw className="h-5 w-5" />
      </IconButton>
      <IconButton
        label="Forward 10 s, hold to fast-forward (L / →)"
        disabled={!tl.seekable || atLive}
        onPointerDown={() => tl.seekable && !atLive && startScan(1)}
        onPointerUp={stopScan}
        onPointerLeave={stopScan}
        onKeyDown={(e) => e.key === 'Enter' && seek(10)}
        className="disabled:opacity-40"
      >
        <RotateCw className="h-5 w-5" />
      </IconButton>

      <VolumeControl volume={volume} mute={mute} />

      <span className="ml-2 whitespace-nowrap text-sm tabular-nums text-white/85">
        {tl.live
          ? atLive
            ? ''
            : `${formatDuration(-tl.behind)} behind live`
          : `${formatDuration(tl.pos)} / ${formatDuration(tl.end)}`}
      </span>
      {tl.live && (
        <button
          type="button"
          onClick={() => !atLive && seek(Math.max(tl.start, tl.end - 1), 'absolute')}
          aria-label={atLive ? 'Live' : 'Go to live (End)'}
          className={`ml-2 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            atLive ? 'bg-danger text-white' : 'bg-white/15 text-white hover:bg-white/25'
          }`}
        >
          <Radio className="h-3.5 w-3.5" aria-hidden="true" />
          {atLive ? 'Live' : 'Go live'}
        </button>
      )}

      <div className="flex-1" />

      {hasMatch && (
        <IconButton label="Match centre (I)" active={insightsOpen} onClick={onToggleInsights}>
          <BarChart3 className="h-5 w-5" />
        </IconButton>
      )}
      <TrackMenu
        label="Audio track"
        icon={<AudioLines className="h-5 w-5" />}
        tracks={audio}
        onPick={(id) => set('aid', id ?? 'auto')}
        onOpenChange={onMenuOpenChange}
      />
      <TrackMenu
        label="Subtitles (C)"
        icon={<Subtitles className="h-5 w-5" />}
        tracks={subs}
        allowOff
        onPick={(id) => set('sid', id === null ? 'no' : id)}
        onOpenChange={onMenuOpenChange}
      />
      {(!tl.live || !atLive) && (
        <SpeedMenu speed={mpv.speed ?? 1} onOpenChange={onMenuOpenChange} />
      )}
      <IconButton label="Mini player" onClick={onMinimize}>
        <PictureInPicture2 className="h-5 w-5" />
      </IconButton>
      <IconButton
        label={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
      </IconButton>
    </div>
  );
});

function VolumeControl({ volume, mute }: { volume: number; mute: boolean }) {
  const Icon = mute || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  return (
    <div className="group/vol flex items-center">
      <IconButton label={mute ? 'Unmute (M)' : 'Mute (M)'} onClick={() => set('mute', !mute)}>
        <Icon className="h-5 w-5" />
      </IconButton>
      <input
        type="range"
        min={0}
        max={130}
        step={1}
        value={mute ? 0 : volume}
        aria-label="Volume"
        onChange={(e) => {
          const v = Number(e.target.value);
          if (mute && v > 0) set('mute', false);
          set('volume', v);
        }}
        className="w-0 cursor-pointer accent-[rgb(var(--color-accent))] opacity-0 transition-all duration-200 focus-visible:w-24 focus-visible:opacity-100 group-hover/vol:w-24 group-hover/vol:opacity-100"
      />
    </div>
  );
}

function Popover({
  label,
  icon,
  disabled,
  onOpenChange,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconButton
        label={label}
        active={open}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="disabled:opacity-40"
      >
        {icon}
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-full right-0 mb-2 max-h-[50vh] min-w-[220px] overflow-y-auto rounded-xl bg-black/90 p-1.5 shadow-2xl ring-1 ring-white/10"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-white/10 focus-visible:bg-white/15 ${
        selected ? 'font-semibold text-accent' : 'text-white'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${selected ? 'bg-accent' : 'bg-transparent'}`}
      />
      {children}
    </button>
  );
}

function TrackMenu({
  label,
  icon,
  tracks,
  allowOff,
  onPick,
  onOpenChange,
}: {
  label: string;
  icon: React.ReactNode;
  tracks: MpvTrack[];
  allowOff?: boolean;
  onPick: (id: number | null) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const none = !tracks.some((t) => t.selected);
  return (
    <Popover label={label} icon={icon} disabled={tracks.length === 0} onOpenChange={onOpenChange}>
      {(close) => (
        <>
          <p className="px-3 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">
            {label}
          </p>
          {allowOff && (
            <MenuItem
              selected={none}
              onClick={() => {
                onPick(null);
                close();
              }}
            >
              Off
            </MenuItem>
          )}
          {tracks.map((t) => (
            <MenuItem
              key={t.id}
              selected={Boolean(t.selected)}
              onClick={() => {
                onPick(t.id);
                close();
              }}
            >
              {trackLabel(t)}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

function SpeedMenu({
  speed,
  onOpenChange,
}: {
  speed: number;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover
      label="Playback speed"
      icon={<Gauge className="h-5 w-5" />}
      onOpenChange={onOpenChange}
    >
      {(close) => (
        <>
          <p className="px-3 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">
            Speed
          </p>
          {SPEEDS.map((s) => (
            <MenuItem
              key={s}
              selected={Math.abs(speed - s) < 0.01}
              onClick={() => {
                set('speed', s);
                close();
              }}
            >
              {s === 1 ? 'Normal' : `${s}×`}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}
