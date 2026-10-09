import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { DISPLAY_DEFAULTS, orderCategories, useDisplayStore } from '../../stores/display-store';
import { usePlayerStore } from '../../stores/player-store';
import { useChannelFilter } from '../../hooks/useChannelFilter';
import { pickNearest } from '../../hooks/useSpatialNavigation';
import { CategoryGrid } from '../../components/CategoryGrid';
import { ChannelCard } from '../../components/ChannelCard';
import type { Channel } from '../../types';

const ch = (id: number, name: string, group?: string, extra: Partial<Channel> = {}): Channel => ({
  id,
  name,
  group_name: group,
  content_type: 'live',
  is_favorite: false,
  ...extra,
});

const rect = (left: number, top: number, w = 100, h = 100) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h }) as globalThis.DOMRect;

beforeEach(() => {
  useDisplayStore.setState(DISPLAY_DEFAULTS);
});

describe('orderCategories', () => {
  const cats = ['b News', 'a Sports', 'c Kids'];
  const counts = new Map([
    ['b News', 3],
    ['a Sports', 9],
    ['c Kids', 1],
  ]);

  it('keeps provider order, drops hidden, puts pinned first in pin order', () => {
    expect(
      orderCategories(cats, counts, {
        categorySort: 'provider',
        pinnedCategories: ['c Kids', 'a Sports'],
        hiddenCategories: ['b News'],
      })
    ).toEqual(['c Kids', 'a Sports']);
  });

  it('sorts A–Z and by channel count', () => {
    const base = { pinnedCategories: [], hiddenCategories: [] };
    expect(orderCategories(cats, counts, { ...base, categorySort: 'az' })).toEqual([
      'a Sports',
      'b News',
      'c Kids',
    ]);
    expect(orderCategories(cats, counts, { ...base, categorySort: 'count' })).toEqual([
      'a Sports',
      'b News',
      'c Kids',
    ]);
  });

  it('puts pinned first, then starred, then the rest by visits', () => {
    expect(
      orderCategories(cats, counts, {
        categorySort: 'visits',
        pinnedCategories: ['c Kids'],
        favoriteCategories: ['b News'],
        hiddenCategories: [],
        categoryVisits: { 'a Sports': 1, 'b News': 0 },
      })
    ).toEqual(['c Kids', 'b News', 'a Sports']);
  });

  it('applies the name filter both ways, and "favorites only"', () => {
    const base = { categorySort: 'provider' as const, pinnedCategories: [], hiddenCategories: [] };
    expect(
      orderCategories(cats, counts, {
        ...base,
        categoryKeywords: ['news', 'KIDS'],
        categoryKeywordMode: 'hide',
      })
    ).toEqual(['a Sports']);
    expect(
      orderCategories(cats, counts, {
        ...base,
        categoryKeywords: ['news', 'KIDS'],
        categoryKeywordMode: 'only',
      })
    ).toEqual(['b News', 'c Kids']);
    expect(
      orderCategories(cats, counts, {
        ...base,
        favoriteCategories: ['a Sports'],
        categoryFavoritesOnly: true,
      })
    ).toEqual(['a Sports']);
  });

  it('lists hidden categories too when asked (the management list)', () => {
    expect(
      orderCategories(
        cats,
        counts,
        { categorySort: 'provider', pinnedCategories: [], hiddenCategories: ['b News'] },
        true
      )
    ).toEqual(cats);
  });
});

describe('pickNearest', () => {
  // A 2x2 grid of cards, 20px apart.
  const grid = [rect(0, 0), rect(120, 0), rect(0, 120), rect(120, 120)];

  it('moves to the neighbour in each direction', () => {
    expect(pickNearest(grid[0], grid, 'ArrowRight')).toBe(1);
    expect(pickNearest(grid[0], grid, 'ArrowDown')).toBe(2);
    expect(pickNearest(grid[3], grid, 'ArrowLeft')).toBe(2);
    expect(pickNearest(grid[3], grid, 'ArrowUp')).toBe(1);
  });

  it('prefers the card straight below over a nearer diagonal one', () => {
    const from = rect(0, 0);
    const straight = rect(0, 200);
    const diagonal = rect(150, 110);
    expect(pickNearest(from, [diagonal, straight], 'ArrowDown')).toBe(1);
  });

  it('finds nothing past the edge', () => {
    expect(pickNearest(grid[0], grid, 'ArrowLeft')).toBe(-1);
  });
});

describe('useChannelFilter with display settings', () => {
  beforeEach(() => {
    usePlayerStore.setState({ contentTypeFilter: 'live', categoryFilter: null, searchQuery: '' });
    usePlayerStore
      .getState()
      .setChannels([
        ch(1, 'Zeta HD', 'News'),
        ch(2, 'Alpha SD', 'News'),
        ch(3, 'Beta', 'Adult'),
        ch(4, 'Gamma', 'Sports', { is_favorite: true }),
        ch(5, 'Movie', 'Films', { content_type: 'vod' }),
      ]);
  });

  const names = () => renderHook(() => useChannelFilter('')).result.current.map((c) => c.name);

  it('drops hidden categories and keyword matches', () => {
    useDisplayStore.setState({ hiddenCategories: ['Adult'], channelKeywords: ['sd'] });
    expect(names()).toEqual(['Zeta HD', 'Gamma']);
  });

  it('shows only matching channels in "only" mode', () => {
    useDisplayStore.setState({ channelKeywords: ['hd', 'beta'], channelKeywordMode: 'only' });
    expect(names()).toEqual(['Zeta HD', 'Beta']);
  });

  it('applies the category name filter to the channels too', () => {
    useDisplayStore.setState({ categoryKeywords: ['news'], categoryKeywordMode: 'only' });
    expect(names()).toEqual(['Zeta HD', 'Alpha SD']);
  });

  it('sorts by most visited', () => {
    useDisplayStore.getState().recordChannelVisit(3, 'Adult');
    useDisplayStore.getState().recordChannelVisit(3, 'Adult');
    useDisplayStore.getState().recordChannelVisit(2, 'News');
    useDisplayStore.setState({ channelSort: 'visits' });
    expect(names()).toEqual(['Beta', 'Alpha SD', 'Zeta HD', 'Gamma']);
    expect(useDisplayStore.getState().categoryVisits).toEqual({ Adult: 2, News: 1 });
  });

  it('sorts A–Z or favorites first', () => {
    useDisplayStore.setState({ channelSort: 'az' });
    expect(names()).toEqual(['Alpha SD', 'Beta', 'Gamma', 'Zeta HD']);
    useDisplayStore.setState({ channelSort: 'favorites' });
    expect(names()[0]).toBe('Gamma');
  });

  it('never hides movies or series by a live category rule', () => {
    usePlayerStore.setState({ contentTypeFilter: 'vod' });
    useDisplayStore.setState({ hiddenCategories: ['Films'], channelKeywords: ['movie'] });
    expect(names()).toEqual(['Movie']);
  });
});

describe('CategoryGrid', () => {
  const channels = [
    ch(1, 'A', 'News'),
    ch(2, 'B', 'News'),
    ch(3, 'C', 'Sports', { is_favorite: true }),
  ];

  it('shows All, Favorites and one card per visible category with counts', () => {
    useDisplayStore.setState({ hiddenCategories: ['Sports'] });
    render(
      <CategoryGrid
        categories={['News', 'Sports']}
        channels={channels}
        onPick={vi.fn()}
        onAll={vi.fn()}
        onFavorites={vi.fn()}
      />
    );
    const cards = Array.from(document.querySelectorAll('[data-focus-key]')).map(
      (b) => b.textContent
    );
    expect(cards).toEqual(['All channels3 channels', 'Favorites1 channel', 'News2 channels']);
  });

  it('stars and pins a category with its buttons or F / P on the card', () => {
    render(
      <CategoryGrid
        categories={['News', 'Sports']}
        channels={channels}
        onPick={vi.fn()}
        onAll={vi.fn()}
        onFavorites={vi.fn()}
      />
    );
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Star Sports' })));
    expect(useDisplayStore.getState().favoriteCategories).toEqual(['Sports']);
    const news = document.querySelector('[data-focus-key="News"]')!;
    act(() => fireEvent.keyDown(news, { key: 'p' }));
    expect(useDisplayStore.getState().pinnedCategories).toEqual(['News']);
    act(() => fireEvent.keyDown(news, { key: 'f' }));
    expect(useDisplayStore.getState().favoriteCategories).toEqual(['Sports', 'News']);
  });

  it('narrows the cards to a search and hides the built-in cards meanwhile', () => {
    render(
      <CategoryGrid
        categories={['News', 'Sports']}
        channels={channels}
        onPick={vi.fn()}
        onAll={vi.fn()}
        onFavorites={vi.fn()}
        query="spo"
      />
    );
    const keys = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]')).map(
      (b) => b.dataset.focusKey
    );
    expect(keys).toEqual(['Sports']);
  });

  it('opens a category and focuses the card it is told to', () => {
    const onPick = vi.fn();
    render(
      <CategoryGrid
        categories={['News', 'Sports']}
        channels={channels}
        onPick={onPick}
        onAll={vi.fn()}
        onFavorites={vi.fn()}
        focusKey="Sports"
      />
    );
    const sports = document.querySelector('[data-focus-key="Sports"]')!;
    expect(document.activeElement).toBe(sports);
    act(() => fireEvent.click(sports));
    expect(onPick).toHaveBeenCalledWith('Sports');
  });
});

describe('ChannelCard age tag', () => {
  const live = ch(1, 'Cinema', 'Movies');
  const layout = { art: 124, textScale: 1, showLogo: true, showEpg: true, showGroup: true };
  const card = (age: number | undefined, ageTagMin?: number) =>
    render(
      <ChannelCard
        channel={live}
        isPlaying={false}
        onPlay={vi.fn()}
        epg={{ current: 'Film', currentAge: age }}
        layout={{ ...layout, ageTagMin }}
      />
    );

  it('shows a red tag for 18 and a grey one below', () => {
    card(18, 10);
    expect(screen.getByLabelText('Rated 18 and up').className).toContain('bg-red-600');
    card(12, 10);
    expect(screen.getByLabelText('Rated 12 and up').className).toContain('bg-neutral-500');
  });

  it('shows no tag under the minimum, without a rating, or with tags off', () => {
    card(7, 10);
    card(undefined, 10);
    card(16, undefined);
    expect(screen.queryByLabelText(/Rated/)).toBeNull();
  });
});
