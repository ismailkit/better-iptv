import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Pin, PinOff, RotateCcw, Star, X } from 'lucide-react';
import { getSetting, setSetting } from '../lib/tauri';
import { getSportsQuota, setSportsKey, type SportsQuota } from '../lib/sports';
import { usePlayerUi } from '../stores/player-ui-store';
import { logger } from '../lib/logger';
import { AgeFilterControl } from './AgeFilterControl';
import {
  orderCategories,
  parseKeywords,
  useDisplayStore,
  type CardSize,
  type CategorySort,
  type ChannelSort,
  type KeywordMode,
} from '../stores/display-store';

interface DisplayPanelProps {
  open: boolean;
  onClose: () => void;
  /** The current section's categories, for the hide/pin list. */
  categories: string[];
  /** Channel count per category, for the list and the "by size" order. */
  counts: Map<string, number>;
  /** The player mode or buffer changed (re-reads what the backend will do). */
  onPlayerConfigChanged?: () => void;
}

const SIZES: Array<{ value: CardSize; label: string }> = [
  { value: 'sm', label: 'S' },
  { value: 'md', label: 'M' },
  { value: 'lg', label: 'L' },
  { value: 'xl', label: 'XL' },
];
const SCALES = [1, 1.25, 1.5, 1.75, 2];
const COLUMNS = [0, 2, 3, 4, 5, 6, 7, 8];

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-text-muted">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`min-w-[52px] rounded-lg border px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-4 focus-visible:ring-accent ${
              value === o.value
                ? 'border-text bg-text text-bg'
                : 'border-border bg-text/5 text-text-muted hover:bg-text/10'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-lg px-1 py-2 text-left outline-none focus-visible:ring-4 focus-visible:ring-accent"
    >
      <span className="text-sm text-text">{label}</span>
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-text/15'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

/**
 * A comma-separated text filter with its mode. The words commit on Enter or
 * when the field loses focus, so the list does not refilter on every key.
 */
function KeywordFilter({
  label,
  placeholder,
  words,
  mode,
  onChange,
}: {
  label: string;
  placeholder: string;
  words: string[];
  mode: KeywordMode;
  onChange: (words: string[], mode: KeywordMode) => void;
}) {
  const [text, setText] = useState(words.join(', '));
  useEffect(() => setText(words.join(', ')), [words]);
  const commit = () => onChange(parseKeywords(text), mode);
  return (
    <div className="flex flex-col gap-2">
      <Segmented<KeywordMode>
        label={label}
        value={mode}
        options={[
          { value: 'hide', label: 'Hide matching' },
          { value: 'only', label: 'Show only matching' },
        ]}
        onChange={(m) => onChange(parseKeywords(text), m)}
      />
      <input
        type="text"
        value={text}
        aria-label={`${label}: words, comma separated`}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-text outline-none focus-visible:ring-4 focus-visible:ring-accent"
      />
      {words.length > 0 && (
        <p className="text-xs text-text-faint">
          {mode === 'hide' ? 'Hiding' : 'Showing only'} names containing{' '}
          {words.map((w) => `“${w}”`).join(' or ')}
        </p>
      )}
    </div>
  );
}

const AGE_MINIMUMS = [3, 7, 10, 12, 16, 18];
const TIMESHIFT_MB = [256, 512, 1024, 2048];
const POLL_SECS = [60, 120, 180, 300];
const DELAY_SECS = [0, 15, 30, 45, 60, 90];

/**
 * The in-app player and the sports data source. These two settings live in
 * the backend (it starts MPV and calls the API), so they are read and
 * written there; the rest are display settings like everything else here.
 */
function PlayerAndSports({ onPlayerConfigChanged }: { onPlayerConfigChanged?: () => void }) {
  const d = useDisplayStore();
  const supported = usePlayerUi((s) => s.embeddedSupported);
  const [mode, setMode] = useState<'embedded' | 'external'>('embedded');
  const [timeshift, setTimeshift] = useState(512);
  const [quota, setQuota] = useState<SportsQuota | null>(null);
  const [key, setKey] = useState('');
  const [keyState, setKeyState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    getSetting('player_mode')
      .then((v) => setMode(v === 'external' ? 'external' : 'embedded'))
      .catch(() => {});
    getSetting('player_timeshift_mb')
      .then((v) => v && setTimeshift(Number(v) || 512))
      .catch(() => {});
    getSportsQuota()
      .then(setQuota)
      .catch(() => {});
  }, []);

  const savePlayer = (name: string, value: string) =>
    setSetting(name, value)
      .then(() => onPlayerConfigChanged?.())
      .catch((err) => logger.warn(`Failed to save ${name}:`, err));

  const saveKey = (value: string) => {
    setKeyState('saving');
    setSportsKey(value)
      .then(() => getSportsQuota())
      .then((q) => {
        setQuota(q);
        setKey('');
        setKeyState('saved');
      })
      .catch(() => setKeyState('error'));
  };

  return (
    <>
      <Section title="Player">
        {supported ? (
          <Segmented
            label="Where channels play"
            value={mode}
            options={[
              { value: 'embedded', label: 'In the app' },
              { value: 'external', label: 'Separate MPV window' },
            ]}
            onChange={(m) => {
              setMode(m);
              void savePlayer('player_mode', m);
            }}
          />
        ) : (
          <p className="-mt-2 text-sm text-text-muted">
            On this system channels play in a separate MPV window; the in-app player needs Windows.
          </p>
        )}
        {supported && mode === 'embedded' && (
          <>
            <Segmented
              label="Mini player size"
              value={d.miniSize}
              options={[
                { value: 'sm', label: 'S' },
                { value: 'md', label: 'M' },
                { value: 'lg', label: 'L' },
              ]}
              onChange={(miniSize) => d.set({ miniSize })}
            />
            <Segmented
              label="Mini player corner"
              value={d.miniCorner}
              options={[
                { value: 'top-left', label: 'Top left' },
                { value: 'top-right', label: 'Top right' },
                { value: 'bottom-left', label: 'Bottom left' },
                { value: 'bottom-right', label: 'Bottom right' },
              ]}
              // Picking a corner also undoes a drag.
              onChange={(miniCorner) => d.set({ miniCorner, miniPos: null })}
            />
            <Segmented
              label="Rewind buffer for live TV (kept on disk; applies to the next channel)"
              value={timeshift}
              options={TIMESHIFT_MB.map((mb) => ({
                value: mb,
                label: mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`,
              }))}
              onChange={(mb) => {
                setTimeshift(mb);
                void savePlayer('player_timeshift_mb', String(mb));
              }}
            />
          </>
        )}
      </Section>

      <Section title="Sports">
        <p className="-mt-2 text-sm text-text-muted">
          Live scores, events, stats and highlights for matches in the guide, from{' '}
          <span className="text-text">Highlightly</span>. The free plan allows 100 requests a day;
          the app caches everything and only asks while a match is open.
        </p>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-text-muted">
            API key{' '}
            {quota?.has_key ? (
              <span className="text-success">
                · saved
                {quota.remaining >= 0
                  ? ` · ${quota.remaining}/${quota.limit} requests left today`
                  : ''}
              </span>
            ) : (
              <span className="text-text-faint">· not set</span>
            )}
          </span>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              autoComplete="off"
              aria-label="Highlightly API key"
              placeholder={quota?.has_key ? 'Paste a new key to replace it' : 'Paste your key'}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyState('idle');
              }}
              onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey(key)}
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-text outline-none focus-visible:ring-4 focus-visible:ring-accent"
            />
            <button
              type="button"
              disabled={!key.trim() || keyState === 'saving'}
              onClick={() => saveKey(key)}
              className="rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent outline-none focus-visible:ring-4 focus-visible:ring-accent/50 disabled:opacity-50"
            >
              Save
            </button>
            {quota?.has_key && (
              <button
                type="button"
                onClick={() => saveKey('')}
                className="rounded-lg border border-border px-3 text-sm text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
              >
                Remove
              </button>
            )}
          </div>
          {keyState === 'saved' && <p className="text-xs text-success">Key saved.</p>}
          {keyState === 'error' && (
            <p className="text-xs text-danger">That key could not be saved.</p>
          )}
        </div>
        <Toggle
          label="Match button on channels showing a match"
          checked={d.matchButtons}
          onChange={(matchButtons) => d.set({ matchButtons })}
        />
        <Segmented
          label="Live update interval while a match is open"
          value={d.sportsPollSecs}
          options={POLL_SECS.map((s) => ({ value: s, label: `${s / 60} min` }))}
          onChange={(sportsPollSecs) => d.set({ sportsPollSecs })}
        />
        <Segmented
          label="Stream delay (lines goals and cards up on the player's timeline)"
          value={d.sportsDelaySecs}
          options={DELAY_SECS.map((s) => ({ value: s, label: `${s} s` }))}
          onChange={(sportsDelaySecs) => d.set({ sportsDelaySecs })}
        />
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-border pb-6">
      <h3 className="font-display text-lg font-semibold text-text">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Slide-over with every Live TV display knob. Changes apply immediately and
 * persist on this device (see display-store).
 */
export function DisplayPanel({
  open,
  onClose,
  categories,
  counts,
  onPlayerConfigChanged,
}: DisplayPanelProps) {
  const d = useDisplayStore();
  const [filter, setFilter] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    // Capture phase, marked handled, so Escape and Backspace close the panel
    // and nothing else (the global shortcuts check defaultPrevented).
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = e.target instanceof globalThis.HTMLInputElement;
      if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const listed = useMemo(() => {
    const all = orderCategories(
      categories,
      counts,
      {
        categorySort: d.categorySort,
        pinnedCategories: d.pinnedCategories,
        favoriteCategories: d.favoriteCategories,
        hiddenCategories: d.hiddenCategories,
        categoryVisits: d.categoryVisits,
      },
      true
    );
    const q = filter.trim().toLowerCase();
    return q ? all.filter((c) => c.toLowerCase().includes(q)) : all;
  }, [
    categories,
    counts,
    d.categorySort,
    d.pinnedCategories,
    d.favoriteCategories,
    d.hiddenCategories,
    d.categoryVisits,
    filter,
  ]);

  if (!open) return null;

  const hidden = new Set(d.hiddenCategories);
  const pinned = new Set(d.pinnedCategories);
  const starred = new Set(d.favoriteCategories);
  const visitCount = Object.keys(d.channelVisits).length;

  // Rendered outside #root, above the in-app player's layer.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Display settings"
        className="relative flex h-full w-[min(560px,100vw)] flex-col border-l border-border bg-bg shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-6 py-5">
          <div>
            <h2 className="font-display text-2xl font-semibold text-text">Display</h2>
            <p className="text-sm text-text-muted">Applies right away, saved on this device</p>
          </div>
          <button
            type="button"
            aria-label="Close display settings"
            onClick={onClose}
            className="rounded-full p-2 text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
          >
            <X className="h-6 w-6" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          <Section title="Interface">
            <Segmented
              label="Interface scale (whole app, for a TV across the room)"
              value={d.uiScale}
              options={SCALES.map((s) => ({ value: s, label: `${Math.round(s * 100)}%` }))}
              onChange={(uiScale) => d.set({ uiScale })}
            />
          </Section>

          <Section title="Categories">
            <Segmented
              label="Layout"
              value={d.categoryView}
              options={[
                { value: 'cards', label: 'Large cards' },
                { value: 'strip', label: 'Chip strip' },
              ]}
              onChange={(categoryView) => d.set({ categoryView })}
            />
            <Segmented
              label="Card size"
              value={d.categoryCardSize}
              options={SIZES}
              onChange={(categoryCardSize) => d.set({ categoryCardSize })}
            />
            <Segmented<CategorySort>
              label="Order"
              value={d.categorySort}
              options={[
                { value: 'provider', label: 'Provider' },
                { value: 'az', label: 'A–Z' },
                { value: 'count', label: 'Most channels' },
                { value: 'visits', label: 'Most visited' },
              ]}
              onChange={(categorySort) => d.set({ categorySort })}
            />
            <KeywordFilter
              label="Category name filter"
              placeholder="e.g. UK, Sports, 4K"
              words={d.categoryKeywords}
              mode={d.categoryKeywordMode}
              onChange={(categoryKeywords, categoryKeywordMode) =>
                d.set({ categoryKeywords, categoryKeywordMode })
              }
            />
            <div className="flex flex-col">
              <Toggle
                label="Show channel counts"
                checked={d.categoryShowCounts}
                onChange={(categoryShowCounts) => d.set({ categoryShowCounts })}
              />
              <Toggle
                label={'Show "All channels" card'}
                checked={d.categoryShowAll}
                onChange={(categoryShowAll) => d.set({ categoryShowAll })}
              />
              <Toggle
                label={'Show "Favorites" card'}
                checked={d.categoryShowFavorites}
                onChange={(categoryShowFavorites) => d.set({ categoryShowFavorites })}
              />
              <Toggle
                label="Only favorite (starred) and pinned categories"
                checked={d.categoryFavoritesOnly}
                onChange={(categoryFavoritesOnly) => d.set({ categoryFavoritesOnly })}
              />
            </div>
          </Section>

          <Section title="Channels">
            <Segmented
              label="Card size"
              value={d.channelCardSize}
              options={SIZES}
              onChange={(channelCardSize) => d.set({ channelCardSize })}
            />
            <Segmented
              label="Columns"
              value={d.channelColumns}
              options={COLUMNS.map((c) => ({ value: c, label: c === 0 ? 'Auto' : String(c) }))}
              onChange={(channelColumns) => d.set({ channelColumns })}
            />
            <Segmented<ChannelSort>
              label="Order"
              value={d.channelSort}
              options={[
                { value: 'provider', label: 'Provider' },
                { value: 'az', label: 'A–Z' },
                { value: 'favorites', label: 'Favorites first' },
                { value: 'visits', label: 'Most visited' },
              ]}
              onChange={(channelSort) => d.set({ channelSort })}
            />
            <div className="flex flex-col">
              <Toggle
                label="Show logos"
                checked={d.channelShowLogo}
                onChange={(channelShowLogo) => d.set({ channelShowLogo })}
              />
              <Toggle
                label="Show now / next programme"
                checked={d.channelShowEpg}
                onChange={(channelShowEpg) => d.set({ channelShowEpg })}
              />
              <Toggle
                label="Show category on the card"
                checked={d.channelShowGroup}
                onChange={(channelShowGroup) => d.set({ channelShowGroup })}
              />
            </div>
            <KeywordFilter
              label="Channel name filter"
              placeholder="e.g. SD, backup, 24/7"
              words={d.channelKeywords}
              mode={d.channelKeywordMode}
              onChange={(channelKeywords, channelKeywordMode) =>
                d.set({ channelKeywords, channelKeywordMode })
              }
            />
          </Section>

          <Section title="Age filter">
            <p className="-mt-2 text-sm text-text-muted">
              Show only channels for an age range, or hide a range. Applies to Live TV by what is on
              now, and to the guide&apos;s programmes.
            </p>
            <AgeFilterControl />
          </Section>

          <Section title="Age tags">
            <p className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-text-muted">
              From the guide&apos;s rating of the programme on now:
              <span className="rounded-md bg-neutral-500 px-1.5 py-0.5 text-xs font-bold text-white">
                +12
              </span>
              under 18,
              <span className="rounded-md bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                +18
              </span>
              adults only.
            </p>
            <Toggle
              label="Show age tags on channel cards"
              checked={d.ageTags}
              onChange={(ageTags) => d.set({ ageTags })}
            />
            <Segmented
              label="Tag ages from"
              value={d.ageTagMin}
              options={AGE_MINIMUMS.map((a) => ({ value: a, label: `+${a}` }))}
              onChange={(ageTagMin) => d.set({ ageTagMin })}
            />
          </Section>

          <PlayerAndSports onPlayerConfigChanged={onPlayerConfigChanged} />

          <Section title="Most visited">
            <p className="-mt-2 text-sm text-text-muted">
              Counts every channel you play and category you open, on this device.{' '}
              {visitCount > 0
                ? `${visitCount.toLocaleString()} channels counted so far.`
                : 'Nothing counted yet.'}
            </p>
            <button
              type="button"
              disabled={visitCount === 0 && Object.keys(d.categoryVisits).length === 0}
              onClick={d.clearVisits}
              className="self-start rounded-lg border border-border px-4 py-2.5 text-sm text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent disabled:opacity-50"
            >
              Clear visit history
            </button>
          </Section>

          <Section title={`Manage categories (${categories.length})`}>
            <p className="-mt-2 text-sm text-text-muted">
              Pinned categories come first, starred ones next. Hidden ones, and their channels,
              leave Live TV and the guide. On a category card, F stars and P pins it.
            </p>
            <div className="flex gap-2">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter categories"
                aria-label="Filter categories"
                className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-text outline-none focus-visible:ring-4 focus-visible:ring-accent"
              />
              <button
                type="button"
                onClick={() =>
                  d.set({
                    hiddenCategories: Array.from(new Set([...d.hiddenCategories, ...listed])),
                  })
                }
                className="rounded-lg border border-border px-3 text-sm text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
              >
                Hide {filter ? 'these' : 'all'}
              </button>
              <button
                type="button"
                onClick={() => {
                  const shown = new Set(listed);
                  d.set({ hiddenCategories: d.hiddenCategories.filter((c) => !shown.has(c)) });
                }}
                className="rounded-lg border border-border px-3 text-sm text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
              >
                Show {filter ? 'these' : 'all'}
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {listed.map((c) => {
                const isHidden = hidden.has(c);
                const isPinned = pinned.has(c);
                const isStarred = starred.has(c);
                return (
                  <li
                    key={c}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                      isHidden ? 'opacity-50' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{c}</span>
                    <span className="text-xs tabular-nums text-text-faint">
                      {counts.get(c) ?? 0}
                    </span>
                    <button
                      type="button"
                      aria-pressed={isStarred}
                      aria-label={`${isStarred ? 'Unstar' : 'Star'} ${c}`}
                      onClick={() => d.toggleFavoriteCategory(c)}
                      className={`rounded-lg p-2 outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent ${
                        isStarred ? 'text-accent-text' : 'text-text-faint'
                      }`}
                    >
                      <Star className={`h-4 w-4 ${isStarred ? 'fill-current' : ''}`} />
                    </button>
                    <button
                      type="button"
                      aria-pressed={isPinned}
                      aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${c}`}
                      onClick={() => d.togglePinnedCategory(c)}
                      className={`rounded-lg p-2 outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent ${
                        isPinned ? 'text-accent-text' : 'text-text-faint'
                      }`}
                    >
                      {isPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      aria-pressed={isHidden}
                      aria-label={`${isHidden ? 'Show' : 'Hide'} ${c}`}
                      onClick={() => d.toggleHiddenCategory(c)}
                      className="rounded-lg p-2 text-text-faint outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
                    >
                      {isHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>

          <button
            type="button"
            onClick={d.reset}
            className="flex items-center justify-center gap-2 self-start rounded-lg border border-border px-4 py-2.5 text-sm text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
          >
            <RotateCcw className="h-4 w-4" />
            Reset display settings
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
