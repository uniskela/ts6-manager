import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { musicBotsApi } from '@/api/music.api';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

/** Displays the selected image, independently of TeamSpeak upload success. */
export function BotAvatar({ botId, name, mode, md5, className, fallback }: {
  botId: number;
  name: string;
  mode?: 'none' | 'default' | 'custom';
  md5?: string | null;
  className?: string;
  fallback?: ReactNode;
}) {
  const userId = useAuthStore((s) => s.user?.id);
  const { data } = useQuery({
    queryKey: ['music-bot-avatar', botId, mode, md5, userId],
    queryFn: ({ signal }) => musicBotsApi.avatar(botId, signal),
    enabled: !!userId && !!mode && mode !== 'none',
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    const url = URL.createObjectURL(data);
    setImage({ blob: data, url });
    return () => URL.revokeObjectURL(url);
  }, [data]);
  const url = mode !== 'none' && image && image.blob === data ? image.url : null;

  return (
    <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-primary', className)}>
      {url ? <img src={url} alt={`Avatar for ${name}`} className="h-full w-full object-contain" />
        : fallback ?? <Bot className="h-5 w-5" aria-hidden="true" />}
    </span>
  );
}
