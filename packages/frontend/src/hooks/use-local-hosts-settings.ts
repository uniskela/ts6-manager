import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

type LocalHostsSettings = { allowedLocalHosts: string[] };

/** An admin LAN-host allowlist read from the settings API (admins only). */
export function useLocalHostsSettings(queryKey: QueryKey, load: () => Promise<LocalHostsSettings>, enabled: boolean) {
  return useQuery({ queryKey, queryFn: load, enabled, staleTime: 60_000 });
}

/** Replace an admin LAN-host allowlist and keep the cached copy in step. */
export function useUpdateLocalHostsSettings(queryKey: QueryKey, save: (hosts: string[]) => Promise<LocalHostsSettings>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: save,
    onSuccess: (data) => qc.setQueryData(queryKey, data),
  });
}
