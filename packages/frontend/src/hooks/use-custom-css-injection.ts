import { useEffect } from 'react';
import { removeCustomCssStyle, syncCustomCssStyle } from '@/lib/custom-css';
import { isSafeUiActive } from '@/lib/safe-ui';
import { useUiStore } from '@/stores/ui.store';

/**
 * Injects stored custom CSS into a single managed `<style>` while the
 * authenticated layout is mounted. Removes it on logout / unmount, when
 * disabled, or when safe-UI is latched for this document.
 */
export function useCustomCssInjection(active: boolean) {
  const customCssText = useUiStore((s) => s.customCssText);
  const customCssEnabled = useUiStore((s) => s.customCssEnabled);

  useEffect(() => {
    const safe = isSafeUiActive();
    if (!active || safe || !customCssEnabled || customCssText.length === 0) {
      removeCustomCssStyle();
      return;
    }
    syncCustomCssStyle(customCssText);
    return () => {
      removeCustomCssStyle();
    };
  }, [active, customCssText, customCssEnabled]);
}
