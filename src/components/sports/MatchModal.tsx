import { useEffect, useRef } from 'react';
import { Play, X } from 'lucide-react';
import { MatchView } from './MatchView';
import { useMatchData } from '../../hooks/useMatchData';
import { SPORT_LABELS } from '../../lib/sports';
import type { DetectedMatch } from '../../lib/matchDetect';
import type { Channel } from '../../types';

interface MatchModalProps {
  channel: Channel;
  detected: DetectedMatch;
  /** When the programme started (picks the day to look on). */
  startMs?: number;
  onClose: () => void;
  onWatch: (channel: Channel) => void;
  onOpenSettings: () => void;
}

/**
 * The match centre: live score, events, stats, line-ups, insights and
 * highlights of the match a channel is showing. Opened from the match
 * button on a channel card.
 */
export function MatchModal({
  channel,
  detected,
  startMs,
  onClose,
  onWatch,
  onOpenSettings,
}: MatchModalProps) {
  const data = useMatchData(detected, startMs, true);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (
        e.key === 'Escape' ||
        (e.key === 'Backspace' && !(e.target instanceof globalThis.HTMLInputElement))
      ) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Match centre: ${detected.home} v ${detected.away}`}
        className="relative flex max-h-[min(860px,92vh)] w-[min(760px,100%)] flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent-text">
              {SPORT_LABELS[detected.sport]}
              {detected.competition ? ` · ${detected.competition}` : ''}
            </p>
            <p className="truncate text-sm text-text-muted">On {channel.name}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              onWatch(channel);
              onClose();
            }}
            className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent outline-none hover:bg-accent-hover focus-visible:ring-4 focus-visible:ring-accent/50"
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            Watch
          </button>
          <button
            type="button"
            aria-label="Close match centre"
            onClick={onClose}
            className="rounded-full p-2 text-text-muted outline-none hover:bg-text/10 focus-visible:ring-4 focus-visible:ring-accent"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-5">
          <MatchView
            detected={detected}
            entry={data.entry}
            match={data.match}
            quota={data.quota}
            onRefresh={data.refresh}
            onLoadHighlights={data.loadHighlights}
            onLoadLineups={data.loadLineups}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </div>
    </div>
  );
}
