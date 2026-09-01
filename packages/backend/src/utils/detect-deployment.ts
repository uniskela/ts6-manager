import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';

export type DeploymentScenarioId =
  | 'same-host'
  | 'ts-docker-host-manager'
  | 'both-docker'
  | 'remote-ts'
  | 'manager-docker-remote-ts';

export type DeploymentConfidence = 'high' | 'medium' | 'low' | 'none';

export interface DeploymentProbeResult {
  host: string;
  port: number;
  dnsResolved: boolean;
  reachable: boolean;
}

export interface DeploymentDetectionResult {
  managerInDocker: boolean;
  probes: DeploymentProbeResult[];
  suggestedScenarioId: DeploymentScenarioId | null;
  suggestedHost: string | null;
  confidence: DeploymentConfidence;
  reason: string;
}

const DEFAULT_WEBQUERY_PORT = 10080;
const PROBE_TIMEOUT_MS = 2000;

const PROBE_HOSTS = ['127.0.0.1', 'teamspeak', 'host.docker.internal'] as const;

export function isManagerInDocker(): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /docker|containerd|kubepods/i.test(cgroup);
  } catch {
    return false;
  }
}

function probeTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function resolveHost(host: string): Promise<boolean> {
  if (net.isIP(host)) return true;
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

export async function probeDeploymentTargets(
  port = DEFAULT_WEBQUERY_PORT,
  managerInDocker = isManagerInDocker(),
): Promise<DeploymentProbeResult[]> {
  const hosts = managerInDocker
    ? PROBE_HOSTS
    : (['127.0.0.1', 'teamspeak'] as const);

  const results: DeploymentProbeResult[] = [];

  for (const host of hosts) {
    const dnsResolved = await resolveHost(host);
    const reachable = dnsResolved ? await probeTcp(host, port) : false;
    results.push({ host, port, dnsResolved, reachable });
  }

  return results;
}

function probeMap(probes: DeploymentProbeResult[]): Record<string, DeploymentProbeResult> {
  return Object.fromEntries(probes.map((p) => [p.host, p]));
}

/** Pure inference from probe results — exported for unit tests. */
export function inferDeploymentScenario(
  managerInDocker: boolean,
  probes: DeploymentProbeResult[],
): Pick<DeploymentDetectionResult, 'suggestedScenarioId' | 'suggestedHost' | 'confidence' | 'reason'> {
  const byHost = probeMap(probes);
  const localhost = byHost['127.0.0.1'];
  const teamspeak = byHost.teamspeak;
  const hostDocker = byHost['host.docker.internal'];

  if (!managerInDocker && localhost?.reachable) {
    return {
      suggestedScenarioId: 'same-host',
      suggestedHost: '127.0.0.1',
      confidence: 'high',
      reason: 'WebQuery is reachable on localhost from the manager host.',
    };
  }

  if (managerInDocker && teamspeak?.reachable) {
    return {
      suggestedScenarioId: 'both-docker',
      suggestedHost: 'teamspeak',
      confidence: 'high',
      reason: 'TeamSpeak responds at hostname "teamspeak" on the manager Docker network.',
    };
  }

  if (managerInDocker && hostDocker?.reachable && !teamspeak?.reachable) {
    return {
      suggestedScenarioId: null,
      suggestedHost: 'host.docker.internal',
      confidence: 'medium',
      reason:
        'TeamSpeak appears reachable on the Docker host (host.docker.internal). '
        + 'Use that as the connection host — common when the manager runs in Docker and TeamSpeak runs on the host (e.g. WSL).',
    };
  }

  if (!managerInDocker && teamspeak?.dnsResolved && teamspeak.reachable) {
    return {
      suggestedScenarioId: 'ts-docker-host-manager',
      suggestedHost: 'teamspeak',
      confidence: 'medium',
      reason: 'TeamSpeak responds at hostname "teamspeak" from the manager host.',
    };
  }

  if (managerInDocker && !localhost?.reachable && !teamspeak?.reachable && !hostDocker?.reachable) {
    return {
      suggestedScenarioId: 'manager-docker-remote-ts',
      suggestedHost: null,
      confidence: 'medium',
      reason:
        'No TeamSpeak found on localhost, Docker host, or the "teamspeak" service name. '
        + 'Your server is likely on a remote host.',
    };
  }

  if (!managerInDocker && !localhost?.reachable && !teamspeak?.reachable) {
    return {
      suggestedScenarioId: 'remote-ts',
      suggestedHost: null,
      confidence: 'low',
      reason:
        'No TeamSpeak found on localhost or "teamspeak". '
        + 'Your server is likely on another machine — use its hostname or IP.',
    };
  }

  if (managerInDocker && localhost?.reachable) {
    return {
      suggestedScenarioId: 'same-host',
      suggestedHost: '127.0.0.1',
      confidence: 'low',
      reason:
        'WebQuery is reachable on localhost inside the manager container. '
        + 'Confirm TeamSpeak is not running in the same container before using this host.',
    };
  }

  return {
    suggestedScenarioId: null,
    suggestedHost: null,
    confidence: 'none',
    reason: 'Could not determine your deployment automatically. Please choose the option that matches your setup.',
  };
}

export async function detectDeploymentScenario(
  port = DEFAULT_WEBQUERY_PORT,
): Promise<DeploymentDetectionResult> {
  const managerInDocker = isManagerInDocker();
  const probes = await probeDeploymentTargets(port, managerInDocker);
  const inference = inferDeploymentScenario(managerInDocker, probes);

  return {
    managerInDocker,
    probes,
    ...inference,
  };
}
