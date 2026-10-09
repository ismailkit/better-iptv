import { useMemo } from 'react';
import { usePlayerStore } from '../stores/player-store';
import type { Section } from '../stores/player-store';
import { shouldBlockChannel } from '../lib/parentalControls';
import { categoryAllowed, passesKeywords, useDisplayStore } from '../stores/display-store';
import type { Channel } from '../types';
import { ageAllowed, inferChannelAge } from '../lib/ageFilter';
import { normalizeEpgId } from '../lib/guideLayout';
import { useCurrentAges } from './useCurrentAges';

/**
 * Consolidated channel filtering hook.
 *
 * Applies filters in order:
 * 1. Content type (instant via pre-filtered arrays) — bypassed in favour of
 *    every channel while a non-empty search query is active, except in the
 *    guide, whose search stays scoped to its own live list.
 * 2. Category filter
 * 3. Parental controls (hide mode)
 * 4. Search query
 * 5. Display settings, live channels only: hidden categories and the
 *    category / channel name filters apply everywhere; the chosen order
 *    applies in Live TV.
 * 6. Age filter, live channels only: by the age of the programme on now,
 *    else what the channel's name says. The guide goes by the name only
 *    (its rows cover other times and days); it filters programmes itself.
 */
export function useChannelFilter(debouncedSearchQuery: string): Channel[] {
  const channels = usePlayerStore((s) => s.channels);
  const liveChannels = usePlayerStore((s) => s.liveChannels);
  const vodChannels = usePlayerStore((s) => s.vodChannels);
  const seriesChannels = usePlayerStore((s) => s.seriesChannels);
  const favoriteChannels = usePlayerStore((s) => s.favoriteChannels);
  const contentTypeFilter = usePlayerStore((s) => s.contentTypeFilter);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const parentalEnabled = usePlayerStore((s) => s.parentalEnabled);
  const parentalUnlocked = usePlayerStore((s) => s.parentalUnlocked);
  const blockedChannelIds = usePlayerStore((s) => s.blockedChannelIds);
  const blockedCategories = usePlayerStore((s) => s.blockedCategories);
  const parentalAutoDetect = usePlayerStore((s) => s.parentalAutoDetect);
  const parentalVisibility = usePlayerStore((s) => s.parentalVisibility);
  const hiddenCategories = useDisplayStore((s) => s.hiddenCategories);
  const categoryKeywords = useDisplayStore((s) => s.categoryKeywords);
  const categoryKeywordMode = useDisplayStore((s) => s.categoryKeywordMode);
  const channelKeywords = useDisplayStore((s) => s.channelKeywords);
  const channelKeywordMode = useDisplayStore((s) => s.channelKeywordMode);
  const channelSort = useDisplayStore((s) => s.channelSort);
  const ageFilter = useDisplayStore((s) => s.ageFilter);
  const currentAges = useCurrentAges(ageFilter.mode !== 'off' && contentTypeFilter !== 'guide');

  // Step 1: Select base list by content type (O(1) - pre-computed).
  // A non-empty search spans every content type (design doc: "search stays
  // cross-type") except in the guide, whose search stays scoped to its own
  // live list.
  const baseList = useMemo(() => {
    const hasQuery = debouncedSearchQuery.trim() !== '';
    if (hasQuery && contentTypeFilter !== 'guide') {
      return channels;
    }
    switch (contentTypeFilter) {
      case 'home':
        // Home lists nothing of its own; its rows come from get_home_rows.
        return [];
      case 'live':
        return liveChannels;
      case 'vod':
        return vodChannels;
      case 'series':
        return seriesChannels;
      case 'favorites':
        return favoriteChannels;
      case 'guide':
        // Every live channel; the guide's own Favorites chip narrows it.
        return liveChannels;
    }
  }, [
    contentTypeFilter,
    liveChannels,
    vodChannels,
    seriesChannels,
    favoriteChannels,
    channels,
    debouncedSearchQuery,
  ]);

  // Step 2-4: Apply category, parental, and search filters. Derived during
  // render: filtering in an effect committed one render of a new section
  // with the previous section's list (posters for live channels, every
  // visible card mounted twice).
  return useMemo(() => {
    let result = baseList;

    // Category filter
    if (categoryFilter) {
      result = result.filter((c) => c.group_name === categoryFilter);
    }

    // Parental controls (hide mode only)
    if (parentalEnabled && !parentalUnlocked && parentalVisibility === 'hide') {
      result = result.filter(
        (c) =>
          !shouldBlockChannel(c, {
            enabled: parentalEnabled,
            autoDetect: parentalAutoDetect,
            blockedIds: blockedChannelIds,
            blockedCategories: blockedCategories,
            unlocked: parentalUnlocked,
          })
      );
    }

    // Search filter
    if (debouncedSearchQuery.trim() !== '') {
      const query = debouncedSearchQuery.toLowerCase();
      result = result.filter(
        (c) => c.name.toLowerCase().includes(query) || c.group_name?.toLowerCase().includes(query)
      );
    }

    // Display settings (live channels only)
    if (hiddenCategories.length > 0 || categoryKeywords.length > 0 || channelKeywords.length > 0) {
      const rules = {
        categorySort: 'provider' as const,
        pinnedCategories: [],
        hiddenCategories,
        categoryKeywords,
        categoryKeywordMode,
      };
      // One verdict per category, not one per channel.
      const allowed = new Map<string, boolean>();
      result = result.filter((c) => {
        if (c.content_type !== 'live') return true;
        if (c.group_name) {
          let ok = allowed.get(c.group_name);
          if (ok === undefined) {
            ok = categoryAllowed(c.group_name, rules);
            allowed.set(c.group_name, ok);
          }
          if (!ok) return false;
        } else if (categoryKeywordMode === 'only' && categoryKeywords.length > 0) {
          return false;
        }
        return passesKeywords(c.name, channelKeywords, channelKeywordMode);
      });
    }
    if (ageFilter.mode !== 'off') {
      result = result.filter((c) => {
        if (c.content_type !== 'live') return true;
        const now = currentAges && c.epg_id ? currentAges.get(normalizeEpgId(c.epg_id)) : undefined;
        return ageAllowed(now ?? inferChannelAge(c.name, c.group_name), ageFilter);
      });
    }
    if (contentTypeFilter === 'live' && channelSort !== 'provider') {
      // Visit counts are read once per list, not subscribed to: playing a
      // channel must not reshuffle the grid under the cursor. The order
      // catches up the next time the list is built.
      const visits = useDisplayStore.getState().channelVisits;
      result = [...result].sort((a, b) =>
        channelSort === 'favorites'
          ? Number(b.is_favorite) - Number(a.is_favorite)
          : channelSort === 'visits'
            ? (visits[b.id] ?? 0) - (visits[a.id] ?? 0)
            : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      );
    }

    return result;
  }, [
    baseList,
    contentTypeFilter,
    hiddenCategories,
    categoryKeywords,
    categoryKeywordMode,
    channelKeywords,
    channelKeywordMode,
    channelSort,
    ageFilter,
    currentAges,
    categoryFilter,
    debouncedSearchQuery,
    parentalEnabled,
    parentalUnlocked,
    parentalAutoDetect,
    blockedChannelIds,
    blockedCategories,
    parentalVisibility,
  ]);
}

/**
 * Content type filter options. Re-exports `Section` so the store stays the
 * single source of truth for the type.
 */
export type ContentTypeFilter = Section;

/**
 * Hook to manage content type filter state
 */
export function useContentTypeFilter() {
  const contentTypeFilter = usePlayerStore((s) => s.contentTypeFilter);
  const setContentTypeFilter = usePlayerStore((s) => s.setContentTypeFilter);

  return {
    activeFilter: contentTypeFilter,
    setFilter: setContentTypeFilter,
  };
}

/**
 * Hook to manage search query state
 */
export function useSearchQuery() {
  const searchQuery = usePlayerStore((s) => s.searchQuery);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);

  return {
    query: searchQuery,
    setQuery: setSearchQuery,
  };
}
