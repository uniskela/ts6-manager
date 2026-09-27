import { useEffect, useState, type RefObject } from 'react';

export interface HorizontalOverflow {
  start: boolean;
  end: boolean;
}

/**
 * Tracks hidden content on either side of a horizontally scrolling element and
 * keeps the currently selected child (`[data-state="active"]`) scrolled into view.
 */
export function useHorizontalOverflow(ref: RefObject<HTMLElement>): HorizontalOverflow {
  const [overflow, setOverflow] = useState<HorizontalOverflow>({ start: false, end: false });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
      const next = { start: element.scrollLeft > 1, end: element.scrollLeft < maximum - 1 };
      setOverflow((current) => (current.start === next.start && current.end === next.end ? current : next));
    };

    const revealActive = () => {
      const active = element.querySelector<HTMLElement>('[data-state="active"]');
      if (!active || element.scrollWidth <= element.clientWidth) return;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const left = active.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft;
      const right = left + active.offsetWidth;
      if (left < element.scrollLeft || right > element.scrollLeft + element.clientWidth) {
        element.scrollTo({ left: Math.max(0, left - 16), behavior: reduceMotion ? 'auto' : 'smooth' });
      }
    };

    update();
    revealActive();
    element.addEventListener('scroll', update, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resizeObserver?.observe(element);
    const mutationObserver = new MutationObserver(() => {
      revealActive();
      update();
    });
    mutationObserver.observe(element, { subtree: true, childList: true, attributeFilter: ['data-state'] });
    return () => {
      element.removeEventListener('scroll', update);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, [ref]);

  return overflow;
}
