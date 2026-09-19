import { randomUUID } from 'node:crypto';

export interface DownloadProgress {
  status: 'pending' | 'downloading' | 'processing' | 'done' | 'error';
  currentItem: number;
  totalItems: number;
  percentage: number | null;
  speed: number | null;
  eta: number | null;
  updatedAt: number;
  error?: string;
}
export type ProgressUpdate = Pick<DownloadProgress, 'status' | 'percentage' | 'speed' | 'eta'>;

/** Only parse our structured template, never URLs, paths or arbitrary yt-dlp output. */
export function parseDownloadProgress(line: string): ProgressUpdate | null {
  if (line.trim() === 'ts6-processing') return { status: 'processing', percentage: 100, speed: null, eta: null };
  if (!line.startsWith('ts6-progress:')) return null;
  try {
    const data = JSON.parse(line.slice('ts6-progress:'.length));
    const finite = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    const downloaded = finite(data.downloaded_bytes);
    const total = finite(data.total_bytes) ?? finite(data.total_bytes_estimate);
    return {
      status: data.status === 'finished' ? 'processing' : 'downloading',
      percentage: downloaded !== null && total ? Math.min(100, downloaded / total * 100) : null,
      speed: finite(data.speed), eta: finite(data.eta),
    };
  } catch { return null; }
}

interface Job extends DownloadProgress {
  id: string; serverId: number; userId: number; createdAt: number;
  controller: AbortController;
  results: unknown[];
  errors: string[];
}
export class DownloadJobs {
  private jobs = new Map<string, Job>();
  constructor(private max = 100, private ttl = 10 * 60_000, private now = Date.now,
    private maxAge = 30 * 60_000) {}

  sweep(): void {
    for (const [id, job] of this.jobs) {
      if (this.now() - job.updatedAt >= this.ttl || this.now() - job.createdAt >= this.maxAge) {
        job.controller.abort();
        this.jobs.delete(id);
      }
    }
  }
  create(serverId: number, userId: number, totalItems: number): Job {
    this.sweep();
    if (this.jobs.size >= this.max || [...this.jobs.values()].filter(j =>
      j.status !== 'done' && j.status !== 'error').length >= 4) throw new Error('Download capacity reached; try again later');
    if (!Number.isInteger(totalItems) || totalItems < 1 || totalItems > 250) throw new Error('Download batch must contain 1–250 items');
    const job: Job = { id: randomUUID(), serverId, userId, createdAt: this.now(), updatedAt: this.now(),
      controller: new AbortController(), status: 'pending', currentItem: 0, totalItems,
      percentage: null, speed: null, eta: null, results: [], errors: [] };
    this.jobs.set(job.id, job);
    return job;
  }
  get(id: string, serverId: number, userId: number) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.serverId !== serverId || job.userId !== userId) return null;
    const { controller, serverId: _server, userId: _user, createdAt: _created, ...publicJob } = job;
    return { ...publicJob, total: job.totalItems, downloaded: job.results.length };
  }
  update(job: Job, patch: Partial<DownloadProgress>): void {
    if (!this.jobs.has(job.id) || job.controller.signal.aborted || job.status === 'done' || job.status === 'error') return;
    Object.assign(job, patch, { updatedAt: this.now() });
  }
  async run(job: Job, items: string[], download: (item: string, progress: (p: ProgressUpdate) => void, signal: AbortSignal) => Promise<unknown>): Promise<void> {
    try {
      for (const [index, item] of items.entries()) {
        job.controller.signal.throwIfAborted();
        this.update(job, { status: 'downloading', currentItem: index + 1, percentage: null, speed: null, eta: null });
        try {
          const result = await download(item, p => this.update(job, p), job.controller.signal);
          job.controller.signal.throwIfAborted();
          job.results.push(result);
        } catch {
          job.controller.signal.throwIfAborted();
          // Never expose subprocess stderr (cookies, paths, signed URLs) through polling.
          job.errors.push(`Item ${index + 1}: download or library save failed. Check extractor availability and source access.`);
        }
      }
      this.update(job, { status: job.errors.length ? 'error' : 'done', percentage: 100,
        speed: null, eta: null, error: job.errors[0] });
    } catch {
      this.update(job, { status: 'error', error: 'Download expired or was cancelled.' });
    }
  }
}

export const downloadJobs = new DownloadJobs();
setInterval(() => downloadJobs.sweep(), 60_000).unref();
