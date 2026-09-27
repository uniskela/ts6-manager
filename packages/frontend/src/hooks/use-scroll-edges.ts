import { useEffect, useState, type RefObject } from 'react';

export interface ScrollEdges {
  top: boolean;
  bottom: boolean;
}

/** Tracks whether a Radix ScrollArea has hidden content above or below its viewport. */
export function useScrollEdges(rootRef: RefObject<HTMLElement>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false });

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) return;

    const update = () => {
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const next = { top: viewport.scrollTop > 1, bottom: viewport.scrollTop < maximum - 1 };
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
