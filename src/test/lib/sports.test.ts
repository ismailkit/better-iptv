import { describe, it, expect } from 'vitest';
import { detectMatch } from '../../lib/matchDetect';
import {
  eventMinute,
  eventWallTime,
  matchPhase,
  runningScores,
  streamPosition,
  type MatchEvent,
} from '../../lib/sports';
import { timelineOf, formatDuration } from '../../lib/player';

describe('detectMatch', () => {
  it.each([
    ['Premier League: Arsenal v Chelsea', undefined, undefined, ['football', 'Arsenal', 'Chelsea']],
    [
      'LIVE: Real Madrid vs. Barcelona (L)',
      'Football',
      undefined,
      ['football', 'Real Madrid', 'Barcelona'],
    ],
    ['NBA: Celtics @ Lakers', undefined, undefined, ['nba', 'Lakers', 'Celtics']],
    ['Flamengo x Santos', undefined, 'Brazil | Futebol', ['football', 'Flamengo', 'Santos']],
    ['Bayern v Dortmund - Bundesliga', undefined, undefined, ['football', 'Bayern', 'Dortmund']],
    ['Six Nations: England v France', undefined, undefined, ['rugby', 'England', 'France']],
  ])('finds the match in %s', (title, category, group, [sport, home, away]) => {
    expect(detectMatch(title, category, group)).toMatchObject({ sport, home, away });
  });

  it('keeps the competition named in the title', () => {
    expect(detectMatch('Premier League: Arsenal v Chelsea')?.competition).toBe('Premier League');
  });

  it.each([
    ['Kramer vs. Kramer', 'Movie', 'Movies'],
    ['Evening News', 'News', 'Sports'],
    ['Late Night - Talk Show', undefined, 'Football'],
    ['The 2024 Season Review: Every Goal From Every Club In The League', undefined, 'Sports'],
  ])('ignores %s', (title, category, group) => {
    expect(detectMatch(title, category, group)).toBeNull();
  });

  it('trusts a dash only with a sport signal outside the channel category', () => {
    expect(detectMatch('Arsenal - Chelsea', undefined, 'Football')).toBeNull();
    expect(detectMatch('Arsenal - Chelsea', 'Football')).toMatchObject({ home: 'Arsenal' });
  });
});

describe('match clock maths', () => {
  const kickoff = Date.UTC(2026, 9, 9, 19, 0);

  it('reads stoppage time', () => {
    expect(eventMinute('45+2')).toBe(47);
    expect(eventMinute("67'")).toBe(67);
  });

  it('adds the half-time interval to second-half events', () => {
    expect(eventWallTime(kickoff, '30')).toBe(kickoff + 30 * 60_000);
    expect(eventWallTime(kickoff, '45+2')).toBe(kickoff + 47 * 60_000);
    expect(eventWallTime(kickoff, '60')).toBe(kickoff + 75 * 60_000);
    expect(eventWallTime(kickoff, '90+3')).toBe(kickoff + 108 * 60_000);
  });

  it('places a moment in the rewind buffer, or nowhere', () => {
    const now = kickoff + 80 * 60_000;
    // Live edge at stream second 5000 shows now - 30 s; the buffer starts at 3000.
    const goal = now - 30_000 - 600_000; // ten minutes before the live edge
    expect(streamPosition(goal, now, 5000, 3000, 30)).toBeCloseTo(4400);
    expect(streamPosition(now - 3_600_000, now, 5000, 3000, 30)).toBeNull();
  });

  it('keeps the running score, own goals included', () => {
    const home = { name: 'Arsenal' };
    const events: MatchEvent[] = [
      { time: '10', type: 'Goal', team: { name: 'Arsenal' } },
      { time: '30', type: 'Yellow Card', team: { name: 'Chelsea' } },
      { time: '50', type: 'Own Goal', team: { name: 'Arsenal' } },
    ];
    expect(runningScores(events, home)).toEqual([
      [1, 0],
      [1, 0],
      [1, 1],
    ]);
    // A feed that lists own goals under the side they counted for.
    expect(runningScores(events, home, [2, 0])[2]).toEqual([2, 0]);
  });

  it('names the phase of a match', () => {
    expect(matchPhase({ state: { description: 'Second half' } } as never)).toBe('live');
    expect(matchPhase({ state: { description: 'Half time' } } as never)).toBe('break');
    expect(matchPhase({ state: { description: 'Finished' } } as never)).toBe('finished');
    expect(matchPhase({ state: { description: 'Not started' } } as never)).toBe('upcoming');
  });
});

describe('timelineOf', () => {
  it('spans the rewind buffer of a live stream', () => {
    const t = timelineOf(
      {
        'time-pos': 900,
        'demuxer-cache-state': { 'seekable-ranges': [{ start: 400, end: 1000 }] },
      },
      true
    );
    expect(t).toMatchObject({ live: true, start: 400, end: 1000, behind: 100, seekable: true });
  });

  it('spans a file from start to duration', () => {
    expect(timelineOf({ 'time-pos': 60, duration: 3600 }, false)).toMatchObject({
      live: false,
      start: 0,
      end: 3600,
    });
  });

  it('formats durations', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(-42)).toBe('−0:42');
  });
});
