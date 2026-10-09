import { describe, it, expect } from 'vitest';
import {
  AGE_FILTER_OFF,
  ageAllowed,
  describeAgeFilter,
  inferChannelAge,
  type AgeFilter,
} from '../../lib/ageFilter';
import { guideTickStep, guideWindow } from '../../lib/guideLayout';

const only = (min: number, max: number, keepUnrated = true): AgeFilter => ({
  mode: 'only',
  min,
  max,
  keepUnrated,
});

describe('ageAllowed', () => {
  it('lets everything through when off', () => {
    expect(ageAllowed(18, AGE_FILTER_OFF)).toBe(true);
    expect(ageAllowed(undefined, AGE_FILTER_OFF)).toBe(true);
  });

  it('shows only the range, ends included', () => {
    const f = only(0, 12);
    expect(ageAllowed(0, f)).toBe(true);
    expect(ageAllowed(12, f)).toBe(true);
    expect(ageAllowed(16, f)).toBe(false);
  });

  it('hides the range', () => {
    const f: AgeFilter = { mode: 'hide', min: 16, max: 18, keepUnrated: true };
    expect(ageAllowed(16, f)).toBe(false);
    expect(ageAllowed(18, f)).toBe(false);
    expect(ageAllowed(12, f)).toBe(true);
  });

  it('keeps or drops unknown ages as asked', () => {
    expect(ageAllowed(undefined, only(0, 12, true))).toBe(true);
    expect(ageAllowed(undefined, only(0, 12, false))).toBe(false);
  });
});

describe('inferChannelAge', () => {
  it('reads adult and children’s channels from the name or category', () => {
    expect(inferChannelAge('XXX Hot', 'Adult')).toBe(18);
    expect(inferChannelAge('Disney Junior', 'PL: Kids')).toBe(0);
    expect(inferChannelAge('Nick Jr.')).toBe(0);
    expect(inferChannelAge('Cartoon Network HD')).toBe(0);
    expect(inferChannelAge('BBC One', 'UK')).toBeUndefined();
  });
});

describe('describeAgeFilter', () => {
  it('summarises the filter for the guide’s button', () => {
    expect(describeAgeFilter(AGE_FILTER_OFF)).toBeNull();
    expect(describeAgeFilter(only(0, 12))).toBe('Only 0–12');
    expect(describeAgeFilter({ mode: 'hide', min: 16, max: 18, keepUnrated: true })).toBe(
      'Hiding 16–18+'
    );
  });
});

describe('guideWindow zoom and shift', () => {
  const now = new Date(2026, 9, 9, 20, 12).getTime();
  const hour = 3_600_000;

  it('keeps the 3 h default', () => {
    const w = guideWindow(now, 0);
    expect(new Date(w.from).getHours()).toBe(19);
    expect(new Date(w.from).getMinutes()).toBe(30);
    expect(w.to - w.from).toBe(3 * hour);
  });

  it('spans the zoom and moves by half a window', () => {
    const w = guideWindow(now, 0, 6, 1);
    expect(w.to - w.from).toBe(6 * hour);
    expect(w.from - guideWindow(now, 0, 6).from).toBe(3 * hour);
  });

  it('centres a later day on the evening', () => {
    const w = guideWindow(now, 1, 12);
    expect(new Date(w.from).getHours()).toBe(13);
    expect(new Date(w.from).getMinutes()).toBe(30);
  });

  it('spaces the time labels by zoom', () => {
    expect(guideTickStep(3)).toBe(hour / 2);
    expect(guideTickStep(6)).toBe(hour);
    expect(guideTickStep(12)).toBe(2 * hour);
  });
});
