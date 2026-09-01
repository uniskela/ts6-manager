export type DeploymentScenarioId =
  | 'same-host'
  | 'ts-docker-host-manager'
  | 'both-docker'
  | 'remote-ts'
  | 'manager-docker-remote-ts';

export interface DeploymentScenario {
  id: DeploymentScenarioId;
  label: string;
  description: string;
  hostPlaceholder: string;
  hostHint: string;
  notes?: string;
}

export const DEPLOYMENT_SCENARIOS: DeploymentScenario[] = [
  {
    id: 'same-host',
    label: 'TS on same machine (bare metal)',
    description: 'TeamSpeak and ts6-manager run on the same host.',
    hostPlaceholder: '127.0.0.1',
    hostHint: 'Use 127.0.0.1 or your LAN IP if the manager cannot reach localhost.',
  },
  {
    id: 'ts-docker-host-manager',
    label: 'TS in Docker, manager on host',
    description: 'TeamSpeak runs in a container; ts6-manager runs on the host or elsewhere outside that container network.',
    hostPlaceholder: 'teamspeak',
    hostHint: 'Use the container name, published host port mapping target, or host.docker.internal from inside Docker.',
  },
  {
    id: 'both-docker',
    label: 'Both in Docker (separate stacks)',
    description: 'TeamSpeak and ts6-manager each run in Docker with separate compose stacks.',
    hostPlaceholder: 'teamspeak',
    hostHint: 'Attach the ts6-manager backend to the TeamSpeak external Docker network and use the TS service/container name as host.',
    notes: 'In docker-compose, add the TS network to the backend service (see README Coolify section).',
  },
  {
    id: 'remote-ts',
    label: 'TS on a remote server',
    description: 'TeamSpeak runs on another machine reachable over the network.',
    hostPlaceholder: 'ts.example.com',
    hostHint: 'Use the hostname or public IP. Ensure firewalls allow WebQuery (default 10080) and SSH (default 10022) from the manager.',
  },
  {
    id: 'manager-docker-remote-ts',
    label: 'Manager in Docker, TS remote',
    description: 'ts6-manager runs in Docker; TeamSpeak is on a remote host or VPS.',
    hostPlaceholder: 'ts.example.com',
    hostHint: 'Use the remote TS hostname or IP. No special Docker networking is required on the manager side.',
  },
];

export const FIELD_HELP = {
  name: 'A friendly label shown in the header server selector.',
  host: 'Hostname or IP address where the TeamSpeak server is reachable from the ts6-manager backend.',
  webqueryPort: 'WebQuery HTTP port on the TS server (default 10080). This is the primary API used by the manager.',
  apiKey: 'WebQuery API key created on the TS server (via apikeyadd or admin tools). Required for all management features.',
  useHttps: 'Enable if WebQuery is served over HTTPS instead of plain HTTP.',
  sshPort: 'SSH ServerQuery port (default 10022). Used for file browser, bot events, and music bot chat commands.',
  sshUsername: 'ServerQuery SSH username (commonly serveradmin).',
  sshPassword: 'ServerQuery SSH password. Stored encrypted; leave blank when editing to keep the existing password.',
} as const;

export const FEATURE_MATRIX = [
  { feature: 'Dashboard, channels, clients, permissions', transport: 'WebQuery' },
  { feature: 'Virtual servers, instance settings', transport: 'WebQuery' },
  { feature: 'Bot flow WebQuery actions', transport: 'WebQuery' },
  { feature: 'File browser', transport: 'SSH' },
  { feature: 'Bot flow event triggers (join, message, etc.)', transport: 'SSH' },
  { feature: 'Music bot !commands in channel chat', transport: 'SSH' },
] as const;

export const TS_PREP_STEPS = [
  {
    title: 'Enable WebQuery HTTP',
    body: 'In your TeamSpeak server configuration, ensure WebQuery HTTP is enabled (not telnet/raw query). Default port is 10080.',
  },
  {
    title: 'Create a WebQuery API key',
    body: 'Generate an API key using ServerQuery or admin tools. Example ServerQuery command:',
    code: 'apikeyadd scope=manage ip=0.0.0.0/0',
  },
  {
    title: 'Enable SSH ServerQuery (optional)',
    body: 'For file browser, bot event triggers, and music bot chat commands, enable SSH access on port 10022 (default) and note the serveradmin credentials.',
  },
  {
    title: 'Open firewall ports',
    body: 'Allow the ts6-manager backend to reach WebQuery (10080) and, if used, SSH (10022).',
  },
] as const;

export const CHECKLIST_ITEMS = [
  { id: 'webquery-enabled', label: 'WebQuery enabled on TS server', manual: true },
  { id: 'api-key-created', label: 'API key created', manual: true },
  { id: 'connection-added', label: 'Connection added in manager', manual: false },
  { id: 'webquery-tested', label: 'WebQuery test passed', manual: false },
  { id: 'ssh-configured', label: 'SSH credentials configured (optional)', manual: false },
] as const;

export type ChecklistItemId = (typeof CHECKLIST_ITEMS)[number]['id'];

export const CHECKLIST_STORAGE_KEY = 'ts6-connection-setup-checklist';
export const NUDGE_DISMISS_STORAGE_KEY = 'ts6-connection-nudge-dismissed';

export const DEFAULT_CONNECTION_FORM = {
  name: '',
  host: '',
  webqueryPort: '10080',
  apiKey: '',
  useHttps: false,
  sshPort: '10022',
  sshUsername: '',
  sshPassword: '',
};

export type ConnectionFormState = typeof DEFAULT_CONNECTION_FORM;
