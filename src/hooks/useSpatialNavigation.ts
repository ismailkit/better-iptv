import { useEffect } from 'react';

/**
 * Arrow-key focus movement for a TV remote's D-pad (and a keyboard).
 *
 * Up/Down/Left/Right move focus to the nearest focusable element in that
 * direction on screen, so a grid of cards, the rail and the top bar are all
 * reachable without Tab. Enter on a focused button already clicks it.
 *
 * - Elements marked `data-nav-skip` are passed over (the favourite star on a
 *   channel card, so one press moves one card).
 * - Text fields keep Left/Right for the caret; Up/Down still leave them.
 * - Selects, sliders, radio groups and Radix tabs keep their own arrows.
 * - While an `aria-modal` dialog is open, movement stays inside it.
 * - With nothing focused, the first press focuses the first `data-nav` element.
 */

type Dir = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el: globalThis.HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.bottom < 0 || r.top > window.innerHeight * 2) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** Nearest candidate in `dir` from `from`: distance along the axis, plus a penalty for drifting off it. */
export function pickNearest(
  from: globalThis.DOMRect,
  candidates: globalThis.DOMRect[],
  dir: Dir
): number {
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((r, i) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let main: number;
    let cross: number;
    switch (dir) {
      case 'ArrowRight':
        main = r.left - from.right;
        cross = Math.abs(cy - fy);
        if (cx <= fx + 1) return;
        break;
      case 'ArrowLeft':
        main = from.left - r.right;
        cross = Math.abs(cy - fy);
        if (cx >= fx - 1) return;
        break;
      case 'ArrowDown':
        main = r.top - from.bottom;
        cross = Math.abs(cx - fx);
        if (cy <= fy + 1) return;
        break;
      case 'ArrowUp':
        main = from.top - r.bottom;
        cross = Math.abs(cx - fx);
        if (cy >= fy - 1) return;
        break;
    }
    // Overlapping edges count as touching; off-axis drift weighs heavier
    // so Down goes to the card below, not a nearer one diagonally.
    const score = Math.max(main, 0) + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function ownsArrows(el: globalThis.HTMLElement, dir: Dir): boolean {
  if (el instanceof globalThis.HTMLSelectElement || el instanceof globalThis.HTMLTextAreaElement)
    return true;
  if (el instanceof globalThis.HTMLInputElement) {
    if (el.type === 'range' || el.type === 'radio' || el.type === 'number') return true;
    // Text-like inputs keep Left/Right for the caret.
    return dir === 'ArrowLeft' || dir === 'ArrowRight';
  }
  if (el.isContentEditable) return true;
  const role = el.getAttribute('role');
  return role === 'tab' || role === 'menuitem' || role === 'menuitemradio' || role === 'option';
}

export function useSpatialNavigation(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const dir = e.key as Dir;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(dir)) return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

      const active = document.activeElement as globalThis.HTMLElement | null;
      const hasFocus = active && active !== document.body;
      if (hasFocus && ownsArrows(active, dir)) return;

      const modal = document.querySelector<globalThis.HTMLElement>('[aria-modal="true"]');
      const root: globalThis.ParentNode = modal ?? document;
      if (modal && hasFocus && !modal.contains(active)) return;

      if (!hasFocus) {
        const first = root.querySelector<globalThis.HTMLElement>('[data-nav]');
        if (first) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      const els = Array.from(root.querySelectorAll<globalThis.HTMLElement>(FOCUSABLE)).filter(
        (el) => el !== active && !el.closest('[data-nav-skip]') && visible(el)
      );
      const i = pickNearest(
        active.getBoundingClientRect(),
        els.map((el) => el.getBoundingClientRect()),
        dir
      );
      if (i < 0) return;
      e.preventDefault();
      els[i].focus();
      els[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
