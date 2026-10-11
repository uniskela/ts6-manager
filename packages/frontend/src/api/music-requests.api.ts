import api from './client';

export interface MusicRequest {
    id: number;
    title: string;
    artist: string | null;
    duration: number | null;
    source: string;
    status: 'available' | 'unavailable';
    requestedAt: string;
}

export const musicRequestsApi = {
    list: (configId: number, botId?: number): Promise<MusicRequest[]> =>
        api.get(`/servers/${configId}/music-requests`, { params: { botId } }).then((r) => r.data),
    replay: (configId: number, id: number, body: { botId: number; enqueue: boolean; replaceSessionIds?: string[] }): Promise<{ success: boolean; queued: number }> =>
        api.post(`/servers/${configId}/music-requests/${id}/replay`, body).then((r) => r.data),
};
