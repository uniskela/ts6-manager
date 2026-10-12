import { useEffect, useState, type RefObject } from 'react';

export interface ScrollEdges {
  top: boolean;
  bottom: boolean;
}

/**
 * `scrollHeight` and `clientHeight` are whole numbers while `scrollTop` is fractional, so
 * at a zoomed or scaled display the furthest scroll position can stop more than a pixel
 * short of `scrollHeight - clientHeight`. Anything within this distance counts as the end.
 */
const EDGE_TOLERANCE_PX = 2;

/** Which edges of a scroll viewport still hide content. */
export function scrollEdgesOf(
  viewport: { scrollTop: number; scrollHeight: number; clientHeight: number },
): ScrollEdges {
  const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  return { top: viewport.scrollTop > EDGE_TOLERANCE_PX, bottom: remaining > EDGE_TOLERANCE_PX };
}

/** Tracks whether a Radix ScrollArea has hidden content above or below its viewport. */
export function useScrollEdges(rootRef: RefObject<HTMLElement>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false });

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) return;

    const update = () => {
      const next = scrollEdgesOf(viewport);
      setEdges((current) => (current.top === next.top && current.bottom === next.bottom ? current : next));
    };

    update();
    viewport.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild);
    return () => {
      viewport.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [rootRef]);

  return edges;
}
