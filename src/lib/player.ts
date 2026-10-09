import { invoke } from '@tauri-apps/api/core';

/**
 * The in-app MPV player (Windows): the backend runs one MPV that draws into
 * the window under the page, and these calls steer it. See
 * src-tauri/src/playback/embedded.rs.
 */

export interface PlayerCapabilities {
  /** This build can play inside the window (Windows). */
  embedded_supported: boolean;
  /** ...and the settings say to. */
  embedded: boolean;
}

export interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  codec?: string;
  selected?: boolean;
  default?: boolean;
  external?: boolean;
  'demux-channel-count'?: number;
  'demux-w'?: number;
  'demux-h'?: number;
}

export interface SeekableRange {
  start: number;
  end: number;
}

/** MPV's observed properties as the backend mirrors them (`player-state` event). */
export interface MpvState {
  'time-pos'?: number | null;
  duration?: number | null;
  pause?: boolean;
  'paused-for-cache'?: boolean;
  'cache-buffering-state'?: number;
  volume?: number;
  mute?: boolean;
  'track-list'?: MpvTrack[];
  aid?: number | false | 'no' | 'auto';
  sid?: number | false | 'no' | 'auto';
  speed?: number;
  seekable?: boolean;
  'demuxer-cache-state'?: {
    'seekable-ranges'?: SeekableRange[];
    'cache-end'?: number;
    'cache-duration'?: number;
  };
  'eof-reached'?: boolean;
  'idle-active'?: boolean;
  width?: number | null;
  height?: number | null;
  /** A file is opening. */
  loading?: boolean;
  /** The last file failed to open. */
  error?: boolean;
  /** The MPV process ended. */
  closed?: boolean;
}

export const PLAYER_STATE_EVENT = 'player-state';

export type SeekMode =
  'relative' | 'absolute' | 'absolute-percent' | 'relative+exact' | 'absolute+exact';

export function getPlayerCapabilities(): Promise<PlayerCapabilities> {
  return invoke('player_capabilities');
}

/** Video rectangle as fractions of the window. */
export function playerSetRect(x: number, y: number, w: number, h: number): Promise<void> {
  return invoke('player_set_rect', { x, y, w, h });
}

export function playerSet(name: string, value: boolean | number | string): Promise<void> {
  return invoke('player_set_property', { name, value });
}

export function playerSeek(value: number, mode: SeekMode = 'relative'): Promise<void> {
  return invoke('player_seek', { value, mode });
}

export function playerFrameStep(back: boolean): Promise<void> {
  return invoke('player_frame_step', { back });
}

/**
 * The span the timeline covers. Live streams: the rewind buffer, ending at
 * the live edge. Files with a duration: start to end.
 */
export interface Timeline {
  live: boolean;
  start: number;
  end: number;
  pos: number;
  /** Seconds behind the live edge (live only). */
  behind: number;
  seekable: boolean;
}

export function timelineOf(s: MpvState, live: boolean): Timeline {
  const pos = s['time-pos'] ?? 0;
  const ranges = s['demuxer-cache-state']?.['seekable-ranges'] ?? [];
  if (!live && s.duration && s.duration > 0) {
    return { live: false, start: 0, end: s.duration, pos, behind: 0, seekable: s.seekable ?? true };
  }
  // The range holding the playhead, else the newest one.
  const range =
    ranges.find((r) => pos >= r.start - 1 && pos <= r.end + 1) ?? ranges[ranges.length - 1];
  const cacheEnd = s['demuxer-cache-state']?.['cache-end'];
  const end = Math.max(range?.end ?? cacheEnd ?? pos, pos);
  const start = Math.min(range?.start ?? pos, pos);
  return {
    live: true,
    start,
    end,
    pos,
    behind: Math.max(0, end - pos),
    seekable: Boolean(range) && end - start > 2,
  };
}

/** "1:02:03" / "4:05"; negative values get a leading minus. */
export function formatDuration(secs: number): string {
  const sign = secs < 0 ? '−' : '';
  const t = Math.floor(Math.abs(secs));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${sign}${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** A track's menu label: "English · AAC 5.1", "Track 3". */
export function trackLabel(t: MpvTrack): string {
  const lang = t.lang ? langName(t.lang) : null;
  const parts = [t.title && t.title !== lang ? t.title : null, lang].filter(Boolean) as string[];
  const name = parts.length ? parts.join(' · ') : `Track ${t.id}`;
  const ch = t['demux-channel-count'];
  const detail = [
    t.codec?.toUpperCase(),
    ch ? (ch === 6 ? '5.1' : ch === 8 ? '7.1' : `${ch}ch`) : null,
  ]
    .filter(Boolean)
    .join(' ');
  return detail ? `${name} · ${detail}` : name;
}

const langNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' });
  } catch {
    return null;
  }
})();

function langName(code: string): string {
  try {
    return langNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The page shows the video through a transparent "hole": the app (#root)
 * is masked out over the video rectangle, or hidden entirely in the full
 * player, and html/body lose their background so MPV's picture, drawn under
 * the page, shows through. Pass null to close the hole.
 */
export function setVideoHole(hole: globalThis.DOMRectReadOnly | 'full' | null) {
  const root = document.documentElement;
  if (hole === null) {
    root.classList.remove('video-hole', 'video-full');
    return;
  }
  if (hole === 'full') {
    root.classList.remove('video-hole');
    root.classList.add('video-full');
    return;
  }
  root.classList.remove('video-full');
  root.classList.add('video-hole');
  root.style.setProperty('--hole-x', `${hole.left}px`);
  root.style.setProperty('--hole-y', `${hole.top}px`);
  root.style.setProperty('--hole-w', `${hole.width}px`);
  root.style.setProperty('--hole-h', `${hole.height}px`);
}
