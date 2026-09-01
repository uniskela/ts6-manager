import { useEffect, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clientsApi } from '@/api/clients.api';
import { cn } from '@/lib/utils';

export function ClientAvatar({
  configId,
  sid,
  clid,
  nickname,
  className,
  fallback,
}: {
  configId: number;
  sid: number;
  clid: number;
  nickname: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const { data } = useQuery({
    queryKey: ['teamspeak-client-avatar', configId, sid, clid],
    queryFn: () => clientsApi.avatar(configId, sid, clid),
    enabled: configId > 0 && sid > 0 && clid > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const objectUrl = useMemo(() => (data ? URL.createObjectURL(data) : null), [data]);

  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!objectUrl) {
    return <>{fallback ?? nickname?.[0]?.toUpperCase() ?? '?'}</>;
  }
  return (
    <img
      src={objectUrl}
      alt={`Profile avatar for ${nickname}`}
      className={cn('h-full w-full object-cover', className)}
    />
  );
}
