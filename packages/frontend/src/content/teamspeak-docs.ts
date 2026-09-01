export const TS6_SERVER_DOCS = {
  home: 'https://mintlify.wiki/teamspeak/teamspeak6-server/introduction',
  quickstart: 'https://mintlify.wiki/teamspeak/teamspeak6-server/quickstart',
  httpQuery: 'https://mintlify.wiki/teamspeak/teamspeak6-server/server-query/http',
  sshQuery: 'https://mintlify.wiki/teamspeak/teamspeak6-server/server-query/ssh',
  authentication: 'https://mintlify.wiki/teamspeak/teamspeak6-server/server-query/authentication',
  queryOverview: 'https://mintlify.wiki/teamspeak/teamspeak6-server/server-query/overview',
  portsNetworking: 'https://mintlify.wiki/teamspeak/teamspeak6-server/configuration/ports-networking',
  dockerConfig: 'https://mintlify.wiki/teamspeak/teamspeak6-server/configuration/overview',
  security: 'https://mintlify.wiki/teamspeak/teamspeak6-server/advanced/security',
  githubDocker: 'https://github.com/teamspeak/teamspeak6-server',
} as const;

export interface SetupDocLink {
  label: string;
  url: string;
}
