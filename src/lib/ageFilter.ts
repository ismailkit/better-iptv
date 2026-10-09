import { isAdultContent } from './parentalControls';

/**
 * The age filter shared by Live TV and the guide: show only an age range,
 * or hide one. Ages come from the guide (a programme's rating, or an "18+"
 * written into its title); a channel whose programme has none falls back to
 * what its name says (adult channels 18, children's channels 0).
 */
export type AgeFilterMode = 'off' | 'only' | 'hide';

export interface AgeFilter {
  mode: AgeFilterMode;
  /** Inclusive range, in years (0 = for all ages). */
  min: number;
  max: number;
  /** Keep channels and programmes whose age is not known. */
  keepUnrated: boolean;
}

export const AGE_FILTER_OFF: AgeFilter = { mode: 'off', min: 0, max: 18, keepUnrated: true };

/** The ages offered as range ends. */
export const AGE_STEPS = [0, 6, 7, 10, 12, 13, 14, 15, 16, 17, 18];

export function ageLabel(age: number): string {
  return age === 0 ? 'All ages' : age === 18 ? '18+' : `${age}`;
}

// Children's channels by name or category: "Disney Junior", "Nick Jr.",
// "KIDS", "Cartoon Network", "Baby TV", and the usual words in other languages.
const KIDS_PATTERN =
  /\b(kids?|junior|jr\b|cartoons?|toons?|baby ?tv|cbeebies|cbbc|boomerang|nickelodeon|nick ?jr|kinder|kika|enfants?|infantil|bambini|dzieci|детск\w*)/i;

/** What a channel's name and category say about its audience, if anything. */
export function inferChannelAge(name: string, group?: string | null): number | undefined {
  if (isAdultContent(name, group ?? undefined)) return 18;
  if (KIDS_PATTERN.test(name) || (group ? KIDS_PATTERN.test(group) : false)) return 0;
  return undefined;
}

/** Whether something of `age` (undefined: not known) passes the filter. */
export function ageAllowed(age: number | undefined, filter: AgeFilter): boolean {
  if (filter.mode === 'off') return true;
  if (age === undefined) return filter.keepUnrated;
  const inRange = age >= filter.min && age <= filter.max;
  return filter.mode === 'only' ? inRange : !inRange;
}

/** "Showing 0–12", "Hiding 16–18+"; null when off. */
export function describeAgeFilter(filter: AgeFilter): string | null {
  if (filter.mode === 'off') return null;
  const range =
    filter.min === filter.max
      ? ageLabel(filter.min)
      : `${filter.min === 0 ? '0' : filter.min}–${ageLabel(filter.max)}`;
  return `${filter.mode === 'only' ? 'Only' : 'Hiding'} ${range}`;
}
