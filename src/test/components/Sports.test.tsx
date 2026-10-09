import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChannelCard } from '../../components/ChannelCard';
import { MatchView } from '../../components/sports/MatchView';
import { Timeline } from '../../components/player/Timeline';
import { usePlayerUi } from '../../stores/player-ui-store';
import type { SportsMatch } from '../../lib/sports';
import type { MatchEntry } from '../../hooks/useMatchData';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const channel = {
  id: 7,
  name: 'Sport 1',
  group_name: 'Sports',
  content_type: 'live' as const,
  is_favorite: false,
};

const match: SportsMatch = {
  id: 1,
  date: new Date(Date.now() - 70 * 60_000).toISOString(),
  league: { name: 'Premier League' },
  homeTeam: { id: 1, name: 'Arsenal' },
  awayTeam: { id: 2, name: 'Chelsea' },
  state: { description: 'Second half', clock: 55, score: { current: '2 - 1' } },
  events: [
    { time: '23', type: 'Goal', team: { name: 'Arsenal' }, player: 'B. Saka' },
    { time: '41', type: 'Goal', team: { name: 'Chelsea' }, player: 'C. Palmer' },
    {
      time: '52',
      type: 'Goal',
      team: { name: 'Arsenal' },
      player: 'K. Havertz',
      assist: 'B. Saka',
    },
    { time: '54', type: 'Red Card', team: { name: 'Chelsea' }, player: 'M. Caicedo' },
  ],
  statistics: [
    { team: { name: 'Arsenal' }, statistics: [{ displayName: 'Possession', value: 0.58 }] },
    { team: { name: 'Chelsea' }, statistics: [{ displayName: 'Possession', value: 0.42 }] },
  ],
};

const entry: MatchEntry = {
  status: 'found',
  summary: match,
  details: match,
  highlights: { status: 'idle' },
  lineups: { status: 'idle' },
};

describe('match button on channel cards', () => {
  it('shows when the programme on now is a match, and opens the match centre', () => {
    const onOpenMatch = vi.fn();
    render(
      <ChannelCard
        channel={channel}
        isPlaying={false}
        onPlay={vi.fn()}
        epg={{ current: 'Premier League: Arsenal v Chelsea' }}
        onOpenMatch={onOpenMatch}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Match centre: Arsenal v Chelsea/ }));
    expect(onOpenMatch).toHaveBeenCalledWith(channel);
  });

  it('stays away from programmes that are not matches', () => {
    render(
      <ChannelCard
        channel={channel}
        isPlaying={false}
        onPlay={vi.fn()}
        epg={{ current: 'Evening News' }}
        onOpenMatch={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /Match centre/ })).toBeNull();
  });
});

describe('MatchView', () => {
  const view = (e: MatchEntry | undefined, m: SportsMatch | null) =>
    render(
      <MatchView
        detected={{ sport: 'football', home: 'Arsenal', away: 'Chelsea' }}
        entry={e}
        match={m}
        quota={{ has_key: true, remaining: 80, limit: 100 }}
        onRefresh={vi.fn()}
        onLoadHighlights={vi.fn()}
        onLoadLineups={vi.fn()}
      />
    );

  it('shows the score, the clock and the events with running scores', () => {
    view(entry, match);
    expect(screen.getByText('2 – 1')).toBeTruthy();
    expect(screen.getByText(/Second half · 55'/)).toBeTruthy();
    expect(screen.getByText('K. Havertz')).toBeTruthy();
    expect(screen.getByText('Assist: B. Saka')).toBeTruthy();
    expect(screen.getByText('80/100 requests left today', { exact: false })).toBeTruthy();
  });

  it('shows statistics as percentages', () => {
    view(entry, match);
    fireEvent.click(screen.getByRole('tab', { name: 'Stats' }));
    expect(screen.getByText('58%')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('explains a missing API key and offers the setting', () => {
    const onOpenSettings = vi.fn();
    render(
      <MatchView
        detected={{ sport: 'football', home: 'Arsenal', away: 'Chelsea' }}
        entry={{
          ...entry,
          status: 'error',
          error: 'Add a Highlightly API key under Display → Sports',
        }}
        match={null}
        quota={null}
        onRefresh={vi.fn()}
        onLoadHighlights={vi.fn()}
        onLoadLineups={vi.fn()}
        onOpenSettings={onOpenSettings}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add API key' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});

describe('Timeline', () => {
  beforeEach(() => {
    // The live edge (stream second 3600) shows now; 30 minutes of buffer.
    usePlayerUi.setState({
      mpv: {
        'time-pos': 3500,
        'demuxer-cache-state': { 'seekable-ranges': [{ start: 1800, end: 3600 }] },
      },
    });
  });

  it('marks the goals and cards inside the rewind buffer', () => {
    const { container } = render(
      <Timeline live match={match} delaySecs={0} onActivity={vi.fn()} />
    );
    // Kickoff 70 min ago; the buffer covers the last 30 min: the 52' goal
    // (15 min half-time added: 67 min after kickoff) and the 54' red card are in,
    // the first-half goals are not.
    const marks = container.querySelectorAll(
      'span.absolute.rounded-full, span.absolute.rounded-\\[2px\\]'
    );
    expect(marks.length).toBeGreaterThanOrEqual(2);
    const slider = screen.getByRole('slider', { name: 'Rewind buffer' });
    expect(slider.getAttribute('aria-valuetext')).toBe('−1:40 behind live');
  });
});
