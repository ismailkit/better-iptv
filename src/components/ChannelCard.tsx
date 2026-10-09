import { memo, useEffect, useMemo, useState } from 'react';
import { Play, Square, Star, Lock, Trophy } from 'lucide-react';
import { detectMatch } from '../lib/matchDetect';
import type { Channel } from '../types';
import type { EpgEntry } from '../stores/player-store';
import { formatClock, progressPercent } from '../lib/epgTime';
import { ColorBars } from './ColorBars';
import { metaLine } from '../lib/tmdb';
import type { TmdbCard } from '../lib/tauri';

interface ChannelCardProps {
  channel: Channel;
  /** Whether this channel is currently playing */
  isPlaying: boolean;
  /** Callback when play/stop button is clicked */
  onPlay: (channel: Channel) => void;
  /** Current/next EPG program for this channel, if any */
  epg?: EpgEntry;
  /** Whether this channel is blocked by parental controls */
  isBlocked?: boolean;
  /** Visibility mode for blocked channels */
  parentalVisibility?: 'hide' | 'lock' | 'blur';
  /** Callback when favorite star is toggled */
  onToggleFavorite?: (channelId: number) => void;
  /** Opens the match centre; the button shows when the programme on now is a match. */
  onOpenMatch?: (channel: Channel) => void;
  /** TMDB card for a movie or series shown in this live-shaped grid (search, Favorites). */
  tmdb?: TmdbCard;
  /** Size and content from the display settings; absent keeps the fixed 208px card. */
  layout?: ChannelCardLayout;
}

export interface ChannelCardLayout {
  /** Logo/artwork area height in px. */
  art: number;
  /** Multiplies the text sizes; 1 is the desktop card. */
  textScale: number;
  showLogo: boolean;
  showEpg: boolean;
  showGroup: boolean;
  /** Smallest age that gets a tag; absent turns age tags off. */
  ageTagMin?: number;
}

/**
 * Live-shaped channel card.
 *
 * A fixed 208px shape: a 124px logo/artwork area (logo image, ColorBars
 * placeholder, playing pill, favourite star, centred play button and a
 * progress line) above an info block (name, group, now/next EPG or a quiet
 * "No guide data" line). Series and VOD items shown in a live-shaped grid
 * (Favorites) reuse this same card with their artwork.
 */
export const ChannelCard = memo(function ChannelCard({
  channel,
  isPlaying,
  onPlay,
  epg,
  isBlocked = false,
  parentalVisibility = 'hide',
  onToggleFavorite,
  onOpenMatch,
  tmdb,
  layout,
}: ChannelCardProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  const [tmdbArtFailed, setTmdbArtFailed] = useState(false);
  useEffect(() => setTmdbArtFailed(false), [tmdb?.poster_url]);
  const tmdbArt = tmdb?.poster_url && !tmdbArtFailed ? tmdb.poster_url : null;
  const artSrc = tmdbArt ?? (channel.logo && !logoFailed ? channel.logo : null);
  const showLogo = Boolean(artSrc) && (layout?.showLogo ?? true);
  // Local text matching only; nothing is fetched until the button is pressed.
  const programme = epg?.current;
  const genre = epg?.currentCategory;
  const match = useMemo(
    () =>
      onOpenMatch && programme
        ? detectMatch(programme, genre, channel.group_name, channel.name)
        : null,
    [onOpenMatch, programme, genre, channel.group_name, channel.name]
  );
  const showEpg = layout?.showEpg ?? true;
  const showGroup = layout?.showGroup ?? true;
  // Text sizes scale with the card through one CSS variable, so the classes
  // below stay the desktop sizes when there is no layout.
  const fs = (px: number) => (layout ? `calc(${px}px * var(--card-text, 1))` : undefined);
  // A movie or series in this grid has no programme; say what it is instead.
  const kindLabel =
    channel.content_type === 'vod' ? 'Movie' : channel.content_type === 'series' ? 'Series' : null;
  const blocked = isBlocked && parentalVisibility !== 'hide';

  const pct =
    epg?.currentStart && epg?.currentEnd ? progressPercent(epg.currentStart, epg.currentEnd) : null;
  const nowTime = epg?.currentStart ? formatClock(epg.currentStart) : '';
  const nextTime = epg?.nextStart ? formatClock(epg.nextStart) : '';
  const ageMin = layout?.ageTagMin;
  const ageTag =
    ageMin !== undefined && epg?.currentAge !== undefined && epg.currentAge >= ageMin && !blocked
      ? epg.currentAge
      : null;

  return (
    // The whole card plays the channel, because that is what every other IPTV
    // player does and what users reach for (issue #55). The card is a mouse
    // shortcut rather than a control of its own: no role or tabIndex, so it
    // neither nests a button inside a button nor adds a third tab stop to every
    // card in a 10,000-channel list. The centred Play button is the keyboard
    // and screen-reader path, and the controls layered on top stop propagation.
    <article
      onClick={() => onPlay(channel)}
      // I opens the match centre from the focused card (keyboard, remote).
      onKeyDown={(e) => {
        if (match && (e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          onOpenMatch?.(channel);
        }
      }}
      style={layout ? ({ '--card-text': layout.textScale } as React.CSSProperties) : undefined}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-[14px] bg-surface transition-transform duration-150 has-[:focus-visible]:z-10 has-[:focus-visible]:scale-[1.03] has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-accent ${
        layout ? '' : 'h-[208px]'
      } ${isPlaying ? 'border-[1.5px] border-accent' : 'border border-border'}`}
    >
      {/* Logo/artwork area */}
      <div
        className={`relative flex items-center justify-center bg-surface-2 ${layout ? '' : 'h-[124px]'}`}
        style={layout ? { height: layout.art } : undefined}
      >
        {showLogo ? (
          <img
            src={artSrc!}
            alt={channel.name}
            loading="lazy"
            decoding="async"
            // Images are draggable by default, and a click that starts with a
            // few pixels of drag becomes a drag gesture that never fires a
            // click - on the logo, the largest target on the card.
            draggable={false}
            onError={() => (tmdbArt ? setTmdbArtFailed(true) : setLogoFailed(true))}
            className="max-h-full max-w-full object-contain p-3"
          />
        ) : (
          <ColorBars label={channel.name} />
        )}

        {(isPlaying || ageTag !== null) && (
          <div className="absolute left-2 top-2 flex items-center gap-1.5">
            {isPlaying && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-on-accent">
                PLAYING
              </span>
            )}
            {ageTag !== null && (
              // Red for adult-only programmes, grey for every lower age.
              <span
                title={`Current programme: ages ${ageTag} and up`}
                aria-label={`Rated ${ageTag} and up`}
                style={{ fontSize: fs(12) }}
                className={`rounded-md px-1.5 py-0.5 text-xs font-bold tabular-nums leading-none text-white shadow ${
                  ageTag >= 18 ? 'bg-red-600' : 'bg-neutral-500'
                }`}
              >
                +{ageTag}
              </span>
            )}
          </div>
        )}

        {/* A blocked card's only control is the unlock button below: the
            favourite and play/stop buttons are not rendered here at all, so a
            blocked channel never exposes a way to favourite it (no PIN
            required) or a second, invisible tab stop underneath the overlay. */}
        {!blocked && (
          <>
            <button
              type="button"
              data-nav-skip
              aria-label={channel.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite?.(channel.id);
              }}
              className={`absolute right-2 top-2 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-black/35 transition-opacity focus-visible:ring-2 focus-visible:ring-accent ${
                channel.is_favorite
                  ? 'opacity-100'
                  : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
              }`}
            >
              <Star
                className={`h-4 w-4 ${
                  channel.is_favorite ? 'fill-current text-accent-text' : 'text-[#F2F2F0]/55'
                }`}
                aria-hidden="true"
              />
            </button>

            {match && (
              <button
                type="button"
                data-nav-skip
                aria-label={`Match centre: ${match.home} v ${match.away} (I)`}
                title={`Match centre: ${match.home} v ${match.away}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenMatch?.(channel);
                }}
                className="absolute right-11 top-2 flex h-[30px] items-center gap-1 rounded-full bg-black/55 px-2 text-[11px] font-bold text-white focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Trophy className="h-3.5 w-3.5 text-accent-text" aria-hidden="true" />
                <span>Match</span>
              </button>
            )}

            <button
              type="button"
              data-nav
              data-channel-id={channel.id}
              aria-label={isPlaying ? `Stop ${channel.name}` : `Play ${channel.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onPlay(channel);
              }}
              className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-on-accent opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
            >
              {isPlaying ? (
                <Square className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </>
        )}

        {pct !== null && (
          <div data-progress className="absolute inset-x-0 bottom-0 h-[3px] bg-text/10">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {/* Info block */}
      <div className="flex flex-col gap-[5px] px-3.5 pb-3.5 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="min-w-0 flex-1 truncate text-sm font-semibold text-text"
            style={{ fontSize: fs(14) }}
          >
            {channel.name}
          </span>
          {showGroup && channel.group_name && (
            <span
              className="shrink-0 truncate text-[11px] text-text-faint"
              style={{ fontSize: fs(11) }}
            >
              {channel.group_name}
            </span>
          )}
        </div>

        {!showEpg && !blocked ? null : blocked ? (
          <p className="truncate text-xs text-text-faint">
            {channel.group_name ? `${channel.group_name} · Locked` : 'Locked'}
          </p>
        ) : epg?.current ? (
          <>
            <div className="flex items-baseline gap-1.5 text-[13px]" style={{ fontSize: fs(13) }}>
              {nowTime && (
                <span className="font-semibold tabular-nums text-accent-text">{nowTime}</span>
              )}
              <span className="truncate text-text">{epg.current}</span>
            </div>
            {epg.next && (
              <div className="flex items-baseline gap-1.5 text-xs" style={{ fontSize: fs(12) }}>
                {nextTime && <span className="tabular-nums text-text-faint">{nextTime}</span>}
                <span className="truncate text-text-faint">{epg.next}</span>
              </div>
            )}
          </>
        ) : epg?.next ? (
          <>
            <p className="text-[13px] text-text-muted">Off air</p>
            <div className="flex items-baseline gap-1.5 text-xs">
              {nextTime && <span className="tabular-nums text-text-faint">{nextTime}</span>}
              <span className="truncate text-text-faint">{epg.next}</span>
            </div>
          </>
        ) : kindLabel ? (
          <p className="truncate text-xs text-text-faint">
            {`${kindLabel} · ${metaLine(tmdb, channel.group_name ?? '')}`}
          </p>
        ) : (
          <p className="text-xs text-text-faint">No guide data</p>
        )}
      </div>

      {blocked && (
        // backdrop-blur on a list item is otherwise off-limits (see global
        // constraints), but the parental "blur" visibility mode is this
        // exception by definition: it is the opt-in feature this button
        // renders, not incidental glass styling, so the blur stays.
        <button
          type="button"
          aria-label={`Unlock ${channel.name} with PIN`}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(channel);
          }}
          className={`absolute inset-0 flex flex-col items-center justify-center gap-2 text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
            parentalVisibility === 'blur' ? 'bg-bg/55 backdrop-blur-md' : 'bg-bg/80'
          }`}
        >
          <Lock className="h-7 w-7" aria-hidden="true" />
          <span className="text-xs font-semibold text-text">Enter PIN to watch</span>
        </button>
      )}
    </article>
  );
});

export default ChannelCard;
