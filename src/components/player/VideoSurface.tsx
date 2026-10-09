import { useLayoutEffect, useRef } from 'react';
import { playerSetRect, setVideoHole } from '../../lib/player';

/**
 * Where the video shows. MPV draws under the page; this box reports its
 * place to the backend (as fractions of the window) and opens a hole in the
 * page over it. Updates are coalesced per frame and only sent when the box
 * moved, so resizing or scrolling never floods the IPC.
 *
 * `full`: the full player hides the whole app instead of masking a hole.
 * `layoutKey`: changes when the box moves without resizing (mini player corner).
 */
export function VideoSurface({
  full,
  layoutKey,
  className,
}: {
  full: boolean;
  layoutKey?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      setVideoHole(full ? 'full' : r);
      playerSetRect(r.left / w, r.top / h, r.width / w, r.height / h).catch(() => {});
    };
    const schedule = () => {
      if (!frame) frame = globalThis.requestAnimationFrame(update);
    };
    update();
    const ro = new globalThis.ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) globalThis.cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      setVideoHole(null);
    };
  }, [full, layoutKey]);

  return <div ref={ref} className={className} aria-hidden="true" />;
}
