import { memo, useEffect, useMemo, useRef } from 'react';
import { LayoutGrid, Pin, Star } from 'lucide-react';
import { BARS } from './ColorBars';
import { CATEGORY_CARD_SIZES, orderCategories, useDisplayStore } from '../stores/display-store';
import type { Channel } from '../types';

interface CategoryGridProps {
  categories: string[];
  /** The section's channels, for counts and the logo preview. */
  channels: Channel[];
  onPick: (category: string) => void;
  onAll: () => void;
  onFavorites: () => void;
  /** The card to focus: a category name, ALL_KEY or FAVORITES_KEY. Absent: the first card. */
  focusKey?: string | null;
  /** Narrows the cards to categories whose name contains this (case-insensitive). */
  query?: string;
}

/** focusKey values for the two built-in cards; NUL never occurs in a category name. */
export const ALL_KEY = '\u0000all';
export const FAVORITES_KEY = '\u0000favorites';

/** A stable colour per category name, from the test-card bars. */
function barFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return BARS[Math.abs(h) % BARS.length];
}

interface TileProps {
  label: string;
  focusKey: string;
  count?: number;
  color: string;
  logos: string[];
  icon?: React.ReactNode;
  height: number;
  onClick: () => void;
  /** Category cards only: star and pin state, and their toggles. */
  favorite?: boolean;
  pinned?: boolean;
  onToggleFavorite?: () => void;
  onTogglePin?: () => void;
}

function Tile({
  label,
  focusKey,
  count,
  color,
  logos,
  icon,
  height,
  onClick,
  favorite,
  pinned,
  onToggleFavorite,
  onTogglePin,
}: TileProps) {
  const showCounts = useDisplayStore((s) => s.categoryShowCounts);
  const actionable = Boolean(onToggleFavorite && onTogglePin);
  return (
    <div className="group relative" style={{ height }}>
      <button
        type="button"
        data-nav
        data-focus-key={focusKey}
        onClick={onClick}
        // F stars and P pins the focused card: a keyboard or a remote with
        // letter keys reaches both without leaving the grid.
        onKeyDown={(e) => {
          if (!actionable || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            onToggleFavorite!();
          } else if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            onTogglePin!();
          }
        }}
        aria-keyshortcuts={actionable ? 'F P' : undefined}
        className="group/card peer relative flex h-full w-full flex-col justify-between overflow-hidden rounded-2xl bg-surface p-5 text-left outline-none transition-transform duration-150 hover:bg-surface-hover focus-visible:z-10 focus-visible:scale-[1.04]"
      >
        {/* The border all round, in the category's colour: thin at rest,
            thicker on hover and much thicker on the selected (focused)
            card. Drawn over the content so its width never moves the text. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-2xl border-2 opacity-60 transition-[border-width,opacity] duration-150 group-hover/card:border-[3px] group-hover/card:opacity-100 group-focus-visible/card:border-[6px] group-focus-visible/card:opacity-100"
          style={{ borderColor: color }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[.07] group-focus-within:opacity-[.14]"
          style={{ background: `radial-gradient(circle at 85% 15%, ${color}, transparent 60%)` }}
        />

        <span className="relative flex items-start justify-between gap-3">
          <span
            className={`line-clamp-2 font-display text-[clamp(1.1rem,1.6vw,2rem)] font-semibold leading-tight text-text ${
              actionable ? 'pr-20' : ''
            }`}
          >
            {label}
          </span>
          {icon}
        </span>

        <span className="relative flex items-end justify-between gap-3">
          {showCounts && count !== undefined ? (
            <span className="text-[clamp(.8rem,1vw,1.15rem)] text-text-muted">
              {count.toLocaleString()} {count === 1 ? 'channel' : 'channels'}
            </span>
          ) : (
            <span />
          )}
          {logos.length > 0 && (
            <span aria-hidden="true" className="flex -space-x-2">
              {logos.map((src) => (
                <img
                  key={src}
                  src={src}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  onError={(e) => (e.currentTarget.style.display = 'none')}
                  className="h-9 w-9 rounded-full border border-border bg-surface-2 object-contain p-1"
                />
              ))}
            </span>
          )}
        </span>
      </button>

      {/* Star and pin sit beside the card's button, not inside it (no nested
          buttons). Always shown when set; otherwise on hover or card focus.
          The arrow keys skip them; F and P do the same from the card. */}
      {actionable && (
        <div className="absolute right-3 top-3 z-20 flex gap-1 transition-transform peer-focus-visible:scale-[1.04]">
          <button
            type="button"
            data-nav-skip
            aria-pressed={favorite}
            aria-label={`${favorite ? 'Unstar' : 'Star'} ${label}`}
            title={favorite ? 'Remove from favorite categories (F)' : 'Favorite category (F)'}
            onClick={onToggleFavorite}
            className={`rounded-full p-2 outline-none transition-opacity hover:bg-text/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent ${
              favorite
                ? 'text-accent-text opacity-100'
                : 'text-text-faint opacity-0 group-hover:opacity-100 peer-focus-visible:opacity-100'
            }`}
          >
            <Star className={`h-5 w-5 ${favorite ? 'fill-current' : ''}`} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-nav-skip
            aria-pressed={pinned}
            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
            title={pinned ? 'Unpin from the top (P)' : 'Pin to the top (P)'}
            onClick={onTogglePin}
            className={`rounded-full p-2 outline-none transition-opacity hover:bg-text/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent ${
              pinned
                ? 'text-accent-text opacity-100'
                : 'text-text-faint opacity-0 group-hover:opacity-100 peer-focus-visible:opacity-100'
            }`}
          >
            <Pin className={`h-5 w-5 ${pinned ? 'fill-current' : ''}`} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Live TV's category screen: one large card per provider category, sized
 * for a TV across the room and reachable with the arrow keys / a remote.
 * Pinned categories come first, starred ones next; order, size, counts and
 * which categories show come from the display settings.
 */
export const CategoryGrid = memo(function CategoryGrid({
  categories,
  channels,
  onPick,
  onAll,
  onFavorites,
  focusKey,
  query = '',
}: CategoryGridProps) {
  const size = useDisplayStore((s) => s.categoryCardSize);
  const categorySort = useDisplayStore((s) => s.categorySort);
  const pinnedCategories = useDisplayStore((s) => s.pinnedCategories);
  const favoriteCategories = useDisplayStore((s) => s.favoriteCategories);
  const hiddenCategories = useDisplayStore((s) => s.hiddenCategories);
  const categoryFavoritesOnly = useDisplayStore((s) => s.categoryFavoritesOnly);
  const categoryKeywords = useDisplayStore((s) => s.categoryKeywords);
  const categoryKeywordMode = useDisplayStore((s) => s.categoryKeywordMode);
  const categoryVisits = useDisplayStore((s) => s.categoryVisits);
  const toggleFavorite = useDisplayStore((s) => s.toggleFavoriteCategory);
  const togglePin = useDisplayStore((s) => s.togglePinnedCategory);
  const showAll = useDisplayStore((s) => s.categoryShowAll);
  const showFavorites = useDisplayStore((s) => s.categoryShowFavorites);
  const { minWidth, height } = CATEGORY_CARD_SIZES[size];

  const { counts, logos, favoriteCount } = useMemo(() => {
    const counts = new Map<string, number>();
    const logos = new Map<string, string[]>();
    let favoriteCount = 0;
    for (const c of channels) {
      if (c.is_favorite) favoriteCount++;
      if (!c.group_name) continue;
      counts.set(c.group_name, (counts.get(c.group_name) ?? 0) + 1);
      if (c.logo) {
        const list = logos.get(c.group_name) ?? [];
        if (list.length < 4 && !list.includes(c.logo)) {
          list.push(c.logo);
          logos.set(c.group_name, list);
        }
      }
    }
    return { counts, logos, favoriteCount };
  }, [channels]);

  const ordered = useMemo(() => {
    const list = orderCategories(categories, counts, {
      categorySort,
      pinnedCategories,
      favoriteCategories,
      hiddenCategories,
      categoryFavoritesOnly,
      categoryKeywords,
      categoryKeywordMode,
      categoryVisits,
    });
    const q = query.trim().toLowerCase();
    return q ? list.filter((c) => c.toLowerCase().includes(q)) : list;
  }, [
    categories,
    counts,
    categorySort,
    pinnedCategories,
    favoriteCategories,
    hiddenCategories,
    categoryFavoritesOnly,
    categoryKeywords,
    categoryKeywordMode,
    categoryVisits,
    query,
  ]);
  const pinnedSet = useMemo(() => new Set(pinnedCategories), [pinnedCategories]);
  const favoriteSet = useMemo(() => new Set(favoriteCategories), [favoriteCategories]);

  // The built-in cards step aside while searching for a category by name.
  const searching = query.trim() !== '';
  const hasAll = showAll && !searching;
  const hasFavorites = showFavorites && favoriteCount > 0 && !searching;

  // Focus once, when the screen opens: the card the user came back from,
  // else the first one. Not on later renders, so typing in the category
  // search never loses focus to a card.
  const gridRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(focusKey);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    // Someone typing in the category search keeps the caret.
    if (document.activeElement instanceof globalThis.HTMLInputElement) return;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>('[data-focus-key]'));
    const target =
      cards.find((c) => c.dataset.focusKey === initialFocus.current) ?? cards[0] ?? null;
    target?.focus();
  }, []);

  return (
    <div
      ref={gridRef}
      role="list"
      aria-label="Channel categories"
      className="grid gap-5"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${minWidth}px, 100%), 1fr))` }}
    >
      {hasAll && (
        <div role="listitem">
          <Tile
            label="All channels"
            focusKey={ALL_KEY}
            count={channels.length}
            color="rgb(var(--color-accent))"
            logos={[]}
            icon={<LayoutGrid className="mt-1 h-5 w-5 shrink-0 text-accent-text" aria-hidden />}
            height={height}
            onClick={onAll}
          />
        </div>
      )}
      {hasFavorites && (
        <div role="listitem">
          <Tile
            label="Favorites"
            focusKey={FAVORITES_KEY}
            count={favoriteCount}
            color="rgb(var(--color-accent))"
            logos={[]}
            icon={
              <Star className="mt-1 h-5 w-5 shrink-0 fill-current text-accent-text" aria-hidden />
            }
            height={height}
            onClick={onFavorites}
          />
        </div>
      )}
      {ordered.map((category) => (
        <div role="listitem" key={category}>
          <Tile
            label={category}
            focusKey={category}
            count={counts.get(category) ?? 0}
            color={barFor(category)}
            logos={logos.get(category) ?? []}
            height={height}
            onClick={() => onPick(category)}
            favorite={favoriteSet.has(category)}
            pinned={pinnedSet.has(category)}
            onToggleFavorite={() => toggleFavorite(category)}
            onTogglePin={() => togglePin(category)}
          />
        </div>
      ))}
      {ordered.length === 0 && (
        <p className="col-span-full py-16 text-center text-text-muted">
          {searching
            ? `No category matches “${query.trim()}”.`
            : categoryFavoritesOnly
              ? 'No favorite categories yet. Star a category (or press F on it) to add it.'
              : categories.length > 0
                ? 'Every category is hidden or filtered out. Change that under Display.'
                : 'This playlist has no categories.'}
        </p>
      )}
    </div>
  );
});
