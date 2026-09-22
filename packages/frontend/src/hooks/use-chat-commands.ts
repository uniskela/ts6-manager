import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { chatCommandsApi } from '../api/music.api';
import type { CreateChatCommandRequest, UpdateChatCommandRequest } from '@ts6/common';

export function useChatCommands(configId: number | null) {
  return useQuery({
    queryKey: ['chat-commands', configId],
    queryFn: () => chatCommandsApi.list(configId!),
    enabled: !!configId,
  });
}

export function useChatCommandPresets(configId: number | null) {
  return useQuery({
    queryKey: ['chat-command-presets', configId],
    queryFn: () => chatCommandsApi.presets(configId!),
    enabled: !!configId,
    staleTime: 60_000,
  });
}

export function useSeedChatCommandPresets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (configId: number) => chatCommandsApi.seedPresets(configId),
    onSuccess: (_, configId) => qc.invalidateQueries({ queryKey: ['chat-commands', configId] }),
  });
}

export function useCreateChatCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, data }: { configId: number; data: CreateChatCommandRequest }) =>
      chatCommandsApi.create(configId, data),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['chat-commands', configId] }),
  });
}

export function useUpdateChatCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      configId,
      id,
      data,
    }: {
      configId: number;
      id: number;
      data: UpdateChatCommandRequest;
    }) => chatCommandsApi.update(configId, id, data),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['chat-commands', configId] }),
  });
}

export function useDeleteChatCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, id }: { configId: number; id: number }) =>
      chatCommandsApi.delete(configId, id),
    onSuccess: (_, { configId }) => qc.invalidateQueries({ queryKey: ['chat-commands', configId] }),
  });
}
