import { useEffect, useState } from 'react';
import { resolveBackgroundMotion, type BackgroundMotion, type ResolvedMotion } from '@/stores/ui.store';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function getSystemPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Resolves the effective on/off state for decorative background motion,
 * tracking the OS-level reduced-motion setting live when following System.
 */
export function useResolvedBackgroundMotion(motion: BackgroundMotion): ResolvedMotion {
  const [systemPrefersReducedMotion, setSystemPrefersReducedMotion] = useState(getSystemPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersReducedMotion(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  return resolveBackgroundMotion(motion, systemPrefersReducedMotion);
}
