import { toast } from 'sonner';

/**
 * Success toast after media starts playing. Stays on the current page and
 * offers a one-click jump to Bot Hub for live status / stop.
 */
export function toastMediaStarted(message: string): void {
  toast.success(message, {
    action: {
      label: 'Open Bot Hub',
      onClick: () => {
        window.location.assign('/bot-hub');
      },
    },
  });
}
