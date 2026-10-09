import type { Channel } from '../types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Days the guide offers: today and the next four. */
export const GUIDE_DAY_COUNT = 5;

/** The guide's zoom levels: hours across the screen. */
export const GUIDE_ZOOM_HOURS = [1, 2, 3, 6, 12];
export const GUIDE_DEFAULT_HOURS = 3;

/**
 * The guide's time window in epoch ms, `hours` wide (its zoom), moved by
 * `shift` half-windows (earlier < 0 < later).
 *
 * Today: from local `now` floored to the half hour, minus a sixth of the
 * window (at least 30 minutes, in half hours), so most of it is still to
 * come: 3 h at 20:12 -> 19:30-22:30. A later day: centred on 19:30 local
 * (3 h -> 18:00-21:00), built from calendar fields so a DST change that day
 * stays correct.
 */
export function guideWindow(
  now: number,
  dayOffset: number,
  hours = GUIDE_DEFAULT_HOURS,
  shift = 0
): { from: number; to: number } {
  const span = hours * HOUR;
  const step = (shift * span) / 2;
  if (dayOffset === 0) {
    const d = new Date(now);
    d.setMinutes(d.getMinutes() >= 30 ? 30 : 0, 0, 0);
    const lead = Math.max(1, Math.round(span / 6 / (30 * MINUTE))) * 30 * MINUTE;
    const from = d.getTime() - lead + step;
    return { from, to: from + span };
  }
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate() + dayOffset;
  const centre = new Date(y, m, day, 19, 30).getTime();
  const from = centre - span / 2 + step;
  return { from, to: from + span };
}

/** Time-header spacing for a window `hours` wide: about six to twelve labels. */
export function guideTickStep(hours: number): number {
  if (hours <= 3) return 30 * MINUTE;
  if (hours <= 6) return HOUR;
  return 2 * HOUR;
}

/**
 * Where a programme sits in a track `width` wide showing `from`-`to`,
 * clamped to the window; null when it is entirely outside the window or its
 * times cannot be used.
 */
export function blockGeometry(
  startIso: string,
  endIso: string,
  from: number,
  to: number,
  width: number
): { left: number; width: number } | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || to <= from) return null;
  if (end <= from || start >= to) return null;
  const span = to - from;
  const clampedStart = Math.max(start, from);
  const clampedEnd = Math.min(end, to);
  return {
    left: ((clampedStart - from) / span) * width,
    width: ((clampedEnd - clampedStart) / span) * width,
  };
}

/**
 * An EPG id in the form the backend stores and returns: trimmed, ASCII
 * lower case (`epg_domain::normalize_epg_id`). Only A-Z is lowered, as in Rust.
 */
export function normalizeEpgId(id: string): string {
  return id.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The span a channel needs programmes in to get a guide row: today 00:00
 * local to the same time `GUIDE_DAY_COUNT` calendar days later. Rows are the
 * same whichever day is shown.
 */
export function guideDataRange(now: number): { from: number; to: number } {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return {
    from: new Date(y, m, day).getTime(),
    to: new Date(y, m, day + GUIDE_DAY_COUNT).getTime(),
  };
}

/**
 * The guide's rows: the channels whose normalized `epg_id` is in
 * `idsWithData`, in list order. `null` means the lookup is not available
 * (it failed): then every channel with a non-blank `epg_id` gets a row.
 */
export function guideChannels(channels: Channel[], idsWithData: Set<string> | null): Channel[] {
  return channels.filter((channel) => {
    const id = channel.epg_id ? normalizeEpgId(channel.epg_id) : '';
    if (id === '') return false;
    return idsWithData === null || idsWithData.has(id);
  });
}
