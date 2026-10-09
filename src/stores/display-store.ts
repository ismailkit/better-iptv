import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isBrowserPreview } from '../lib/browserPreview';
import { logger } from '../lib/logger';
import { AGE_FILTER_OFF, type AgeFilter } from '../lib/ageFilter';

/**
 * How Live TV looks and what it lists: the knobs that make it usable from a
 * sofa (bigger cards, a category screen, a larger interface), the filters a
 * big provider list needs (hidden, pinned and starred categories, text
 * filters), age tags, and how often things were watched ("Most visited").
 *
 * Applies the moment it changes, so the effect shows while tuning it, and is
 * kept per device in localStorage rather than per profile in SQLite: a TV and
 * a laptop want different sizes for the same account.
 */

export type CardSize = 'sm' | 'md' | 'lg' | 'xl';
export type CategorySort = 'provider' | 'az' | 'count' | 'visits';
export type ChannelSort = 'provider' | 'az' | 'favorites' | 'visits';
/** Whether a text filter hides what matches, or shows only what matches. */
export type KeywordMode = 'hide' | 'only';

export interface DisplaySettings {
  /** Zoom for the whole interface, 1 = 100%. 1.5-2 suits a TV across a room. */
  uiScale: number;

  /** Live TV opens on a screen of category cards, or the old chip strip above the channels. */
  categoryView: 'cards' | 'strip';
  categoryCardSize: CardSize;
  categorySort: CategorySort;
  categoryShowCounts: boolean;
  /** "All channels" and "Favorites" cards ahead of the provider's categories. */
  categoryShowAll: boolean;
  categoryShowFavorites: boolean;
  /** Categories left out of the category list, and their channels out of Live TV and the guide. */
  hiddenCategories: string[];
  /** Listed first, in this order. */
  pinnedCategories: string[];
  /** Starred categories: listed right after the pinned ones. */
  favoriteCategories: string[];
  /** The category screen lists only the starred (and pinned) categories. */
  categoryFavoritesOnly: boolean;
  /** Text filter on category names (case-insensitive); applies to their channels too. */
  categoryKeywords: string[];
  categoryKeywordMode: KeywordMode;

  /** 0 = pick from the card size and the window width. */
  channelColumns: number;
  channelCardSize: CardSize;
  channelSort: ChannelSort;
  channelShowLogo: boolean;
  channelShowEpg: boolean;
  channelShowGroup: boolean;
  /** Text filter on channel names (case-insensitive), in Live TV and the guide. */
  channelKeywords: string[];
  channelKeywordMode: KeywordMode;

  /** Age tag on a channel card from the current programme's rating. */
  ageTags: boolean;
  /** Ages under this get no tag. */
  ageTagMin: number;

  /** Times each channel was played (by id) and each category opened, for "Most visited". */
  channelVisits: Record<string, number>;
  categoryVisits: Record<string, number>;

  /** Age filter for Live TV channels and guide programmes. */
  ageFilter: AgeFilter;
  /** Hours the TV guide shows across (its zoom). */
  guideHours: number;

  /** In-app player: the mini player's size and corner. */
  miniSize: 'sm' | 'md' | 'lg';
  miniCorner: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  /** Where the mini player was dragged to (top-left, px); null keeps it in `miniCorner`. */
  miniPos: { x: number; y: number } | null;

  /** Match centre button on cards whose programme is a match. */
  matchButtons: boolean;
  /** Seconds between live match updates while a match is on screen. */
  sportsPollSecs: number;
  /** How far the stream runs behind the real match, for placing events on the timeline. */
  sportsDelaySecs: number;
}

interface DisplayState extends DisplaySettings {
  set: (patch: Partial<DisplaySettings>) => void;
  toggleHiddenCategory: (category: string) => void;
  togglePinnedCategory: (category: string) => void;
  toggleFavoriteCategory: (category: string) => void;
  /** A channel was played; its category counts as visited too. */
  recordChannelVisit: (channelId: number, category?: string) => void;
  recordCategoryVisit: (category: string) => void;
  clearVisits: () => void;
  /** Back to the default look and filters; visit counts are kept (clearVisits drops them). */
  reset: () => void;
}

export const DISPLAY_DEFAULTS: DisplaySettings = {
  uiScale: 1,
  categoryView: 'cards',
  categoryCardSize: 'lg',
  categorySort: 'provider',
  categoryShowCounts: true,
  categoryShowAll: true,
  categoryShowFavorites: true,
  hiddenCategories: [],
  pinnedCategories: [],
  favoriteCategories: [],
  categoryFavoritesOnly: false,
  categoryKeywords: [],
  categoryKeywordMode: 'hide',
  channelColumns: 0,
  channelCardSize: 'md',
  channelSort: 'provider',
  channelShowLogo: true,
  channelShowEpg: true,
  channelShowGroup: true,
  channelKeywords: [],
  channelKeywordMode: 'hide',
  ageTags: true,
  ageTagMin: 10,
  channelVisits: {},
  categoryVisits: {},
  ageFilter: AGE_FILTER_OFF,
  guideHours: 3,
  miniSize: 'md',
  miniCorner: 'top-right',
  miniPos: null,
  matchButtons: true,
  sportsPollSecs: 120,
  sportsDelaySecs: 45,
};

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function bump(counts: Record<string, number>, key: string): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

export const useDisplayStore = create<DisplayState>()(
  persist(
    (set) => ({
      ...DISPLAY_DEFAULTS,
      set: (patch) => set(patch),
      toggleHiddenCategory: (category) =>
        set((s) => ({ hiddenCategories: toggle(s.hiddenCategories, category) })),
      togglePinnedCategory: (category) =>
        set((s) => ({ pinnedCategories: toggle(s.pinnedCategories, category) })),
      toggleFavoriteCategory: (category) =>
        set((s) => ({ favoriteCategories: toggle(s.favoriteCategories, category) })),
      recordChannelVisit: (channelId, category) =>
        set((s) => ({
          channelVisits: bump(s.channelVisits, String(channelId)),
          categoryVisits: category ? bump(s.categoryVisits, category) : s.categoryVisits,
        })),
      recordCategoryVisit: (category) =>
        set((s) => ({ categoryVisits: bump(s.categoryVisits, category) })),
      clearVisits: () => set({ channelVisits: {}, categoryVisits: {} }),
      reset: () =>
        set((s) => ({
          ...DISPLAY_DEFAULTS,
          channelVisits: s.channelVisits,
          categoryVisits: s.categoryVisits,
        })),
    }),
    {
      name: 'display-settings',
      version: 2,
      // Version 1 called the channel text filter `hiddenKeywords` (hide only).
      migrate: (persisted, version) => {
        const old = (persisted ?? {}) as Partial<DisplaySettings> & { hiddenKeywords?: string[] };
        if (version < 2 && old.hiddenKeywords) {
          old.channelKeywords = old.hiddenKeywords;
          delete old.hiddenKeywords;
        }
        return old as DisplayState;
      },
      // A setting added later starts from its default instead of undefined.
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<DisplaySettings>) }),
    }
  )
);

/** Mini player width in px, per size (16:9 video). */
export const MINI_WIDTHS: Record<DisplaySettings['miniSize'], number> = {
  sm: 320,
  md: 420,
  lg: 560,
};

/** Minimum category card width and height in px, per size. */
export const CATEGORY_CARD_SIZES: Record<CardSize, { minWidth: number; height: number }> = {
  sm: { minWidth: 180, height: 96 },
  md: { minWidth: 240, height: 128 },
  lg: { minWidth: 300, height: 160 },
  xl: { minWidth: 400, height: 210 },
};

/** Channel card logo-area height in px, and the minimum width used to pick a column count. */
export const CHANNEL_CARD_SIZES: Record<CardSize, { minWidth: number; art: number }> = {
  sm: { minWidth: 170, art: 90 },
  md: { minWidth: 220, art: 124 },
  lg: { minWidth: 300, art: 170 },
  xl: { minWidth: 400, art: 230 },
};

/**
 * Zooms the whole interface. In the app this is the webview's own zoom (what
 * Ctrl + / - does in a browser), so layout and scroll maths stay in one unit.
 * The browser preview has no webview to ask and uses CSS `zoom` instead.
 */
export function applyUiScale(scale: number) {
  if (typeof document === 'undefined') return;
  if (isBrowserPreview) {
    document.documentElement.style.setProperty('zoom', scale === 1 ? '' : String(scale));
    return;
  }
  try {
    getCurrentWebview()
      .setZoom(scale)
      .catch((err) => logger.warn('Failed to set the interface scale:', err));
  } catch (err) {
    logger.warn('Failed to set the interface scale:', err);
  }
}

/** True when `text` passes a keyword filter: no words, or none (hide) / some (only) occur in it. */
export function passesKeywords(text: string, words: string[], mode: KeywordMode): boolean {
  if (words.length === 0) return true;
  const t = text.toLowerCase();
  const hit = words.some((w) => t.includes(w.toLowerCase()));
  return mode === 'only' ? hit : !hit;
}

/** Splits "SD, backup ,24/7" into trimmed, non-empty words. */
export function parseKeywords(text: string): string[] {
  return text
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** The settings that decide which categories show and in what order. */
export type CategoryRules = Pick<
  DisplaySettings,
  'categorySort' | 'pinnedCategories' | 'hiddenCategories'
> &
  Partial<
    Pick<
      DisplaySettings,
      | 'favoriteCategories'
      | 'categoryFavoritesOnly'
      | 'categoryKeywords'
      | 'categoryKeywordMode'
      | 'categoryVisits'
    >
  >;

/** Whether a category's channels belong in Live TV: not hidden, and through the name filter. */
export function categoryAllowed(category: string, rules: CategoryRules): boolean {
  return (
    !rules.hiddenCategories.includes(category) &&
    passesKeywords(category, rules.categoryKeywords ?? [], rules.categoryKeywordMode ?? 'hide')
  );
}

/**
 * Category order for display: pinned first (in pin order), then starred, then
 * the rest by the chosen sort. Hidden, filtered-out and (with "favorites
 * only") unstarred, unpinned categories are left out unless `includeHidden`
 * (the management list, which lists everything).
 */
export function orderCategories(
  categories: string[],
  counts: Map<string, number>,
  rules: CategoryRules,
  includeHidden = false
): string[] {
  const favorites = new Set(rules.favoriteCategories ?? []);
  const pins = new Set(rules.pinnedCategories);
  const visible = includeHidden
    ? categories
    : categories.filter(
        (c) =>
          categoryAllowed(c, rules) &&
          (!rules.categoryFavoritesOnly || favorites.has(c) || pins.has(c))
      );
  const sorted = [...visible];
  const visits = rules.categoryVisits ?? {};
  if (rules.categorySort === 'az') {
    sorted.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  } else if (rules.categorySort === 'count') {
    sorted.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  } else if (rules.categorySort === 'visits') {
    sorted.sort((a, b) => (visits[b] ?? 0) - (visits[a] ?? 0));
  }
  const present = new Set(sorted);
  const pinned = rules.pinnedCategories.filter((c) => present.has(c));
  const starred = sorted.filter((c) => favorites.has(c) && !pins.has(c));
  const rest = sorted.filter((c) => !favorites.has(c) && !pins.has(c));
  return [...pinned, ...starred, ...rest];
}
