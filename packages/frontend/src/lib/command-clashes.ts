export type CommandNameSource = 'custom' | 'flow' | 'builtin';

export interface CommandClash {
  name: string;
  sources: CommandNameSource[];
}

/** Normalize for clash comparison: trim, strip leading "!", lowercase. */
export function normalizeCommandName(raw: string): string {
  return raw.trim().replace(/^!+/, '').toLowerCase();
}

type FlowNodeLike = {
  type?: string;
  config?: { command?: unknown };
  data?: { triggerType?: string; commandName?: unknown };
};

type BotWithFlow = {
  flowData?: { nodes?: FlowNodeLike[] } | null;
};

/** Collect raw command strings from editor- or engine-shaped flow nodes. */
export function collectFlowCommandNames(bots: BotWithFlow[]): string[] {
  const names: string[] = [];
  for (const bot of bots) {
    for (const node of bot.flowData?.nodes ?? []) {
      if (node.type === 'trigger_command' && typeof node.config?.command === 'string' && node.config.command.trim()) {
        names.push(node.config.command);
        continue;
      }
      if (node.data?.triggerType === 'command' && typeof node.data.commandName === 'string' && node.data.commandName.trim()) {
        names.push(node.data.commandName);
      }
    }
  }
  return names;
}

const SOURCE_ORDER: CommandNameSource[] = ['custom', 'flow', 'builtin'];

const SOURCE_LABEL: Record<CommandNameSource, string> = {
  custom: 'a custom reply',
  flow: 'a flow command trigger',
  builtin: 'a built-in command',
};

/** Return command names that are registered by at least two command sources. */
export function findCommandClashes(input: {
  custom: string[];
  flows: string[];
  builtins: readonly string[];
}): CommandClash[] {
  const byName = new Map<string, Set<CommandNameSource>>();

  const add = (raw: string, source: CommandNameSource) => {
    const name = normalizeCommandName(raw);
    if (!name) return;
    let set = byName.get(name);
    if (!set) {
      set = new Set();
      byName.set(name, set);
    }
    set.add(source);
  };

  for (const name of input.custom) add(name, 'custom');
  for (const name of input.flows) add(name, 'flow');
  for (const name of input.builtins) add(name, 'builtin');

  const clashes: CommandClash[] = [];
  for (const [name, sources] of byName) {
    if (sources.size < 2) continue;
    clashes.push({
      name,
      sources: SOURCE_ORDER.filter((s) => sources.has(s)),
    });
  }
  clashes.sort((a, b) => a.name.localeCompare(b.name));
  return clashes;
}

/** Format a clash for the warning shown beside command configuration. */
export function describeCommandClash(clash: CommandClash): string {
  const labels = clash.sources.map((s) => SOURCE_LABEL[s]);
  if (labels.length === 2) {
    return `!${clash.name} is used as ${labels[0]} and ${labels[1]}`;
  }
  return `!${clash.name} is used as ${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Clashes involving one command name (e.g. the flow editor's current trigger). */
/** Find the clash affecting one command name, if any. */
export function clashesForCommand(
  command: string,
  input: { custom: string[]; flows: string[]; builtins: readonly string[] },
): CommandClash | null {
  const target = normalizeCommandName(command);
  if (!target) return null;
  return findCommandClashes(input).find((c) => c.name === target) ?? null;
}
