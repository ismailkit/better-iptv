import { AGE_STEPS, ageLabel, type AgeFilter, type AgeFilterMode } from '../lib/ageFilter';
import { useDisplayStore } from '../stores/display-store';

const MODES: Array<{ value: AgeFilterMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'only', label: 'Show only' },
  { value: 'hide', label: 'Hide' },
];

/**
 * The age filter's settings: off, show only a range, or hide a range, and
 * what happens to channels and programmes without a known age. One setting
 * for Live TV and the guide; shown in the Display panel and the guide's
 * filter menu.
 */
export function AgeFilterControl() {
  const filter = useDisplayStore((s) => s.ageFilter);
  const setDisplay = useDisplayStore((s) => s.set);
  const update = (patch: Partial<AgeFilter>) => {
    const next = { ...filter, ...patch };
    // Keep the range the right way round whichever end moved.
    if (next.min > next.max) {
      if (patch.min !== undefined) next.max = next.min;
      else next.min = next.max;
    }
    setDisplay({ ageFilter: next });
  };
  const off = filter.mode === 'off';

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Age filter" className="flex flex-wrap gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={filter.mode === m.value}
            onClick={() => {
              // From the untouched full range, start on the usual choice:
              // children's ages to show, adult ages to hide.
              const full = filter.min === 0 && filter.max === 18;
              if (full && m.value === 'only') update({ mode: m.value, max: 12 });
              else if (full && m.value === 'hide') update({ mode: m.value, min: 16 });
              else update({ mode: m.value });
            }}
            className={`min-w-[52px] rounded-lg border px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-4 focus-visible:ring-accent ${
              filter.mode === m.value
                ? 'border-text bg-text text-bg'
                : 'border-border bg-text/5 text-text-muted hover:bg-text/10'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className={`flex flex-wrap items-center gap-2 text-sm ${off ? 'opacity-50' : ''}`}>
        <span className="text-text-muted">Ages</span>
        <AgeSelect
          label="From age"
          value={filter.min}
          disabled={off}
          onChange={(min) => update({ min })}
        />
        <span className="text-text-muted">to</span>
        <AgeSelect
          label="To age"
          value={filter.max}
          disabled={off}
          onChange={(max) => update({ max })}
        />
      </div>

      <label
        className={`flex cursor-pointer items-center gap-2 text-sm text-text ${off ? 'opacity-50' : ''}`}
      >
        <input
          type="checkbox"
          checked={filter.keepUnrated}
          disabled={off}
          onChange={(e) => update({ keepUnrated: e.target.checked })}
          className="h-4 w-4 accent-[rgb(var(--color-accent))]"
        />
        Keep channels and programmes with no known age
      </label>

      <p className="text-xs text-text-faint">
        Ages come from the guide&apos;s rating of a programme, or an age in its title like
        &ldquo;(16+)&rdquo;. Without one, adult and children&apos;s channels are recognised by name
        (18+ and All ages). Many providers&apos; guides carry no ratings at all.
      </p>
    </div>
  );
}

function AgeSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (age: number) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-text outline-none focus-visible:ring-4 focus-visible:ring-accent"
    >
      {AGE_STEPS.map((a) => (
        <option key={a} value={a}>
          {ageLabel(a)}
        </option>
      ))}
    </select>
  );
}
