/**
 * Minimal Prometheus text exposition parser (skeleton).
 *
 * Parses HELP/TYPE comments and sample lines into a generic structure.
 * Does **not** define an allow-list of TeamSpeak metric names — that must be
 * derived from a real beta13 fixture (`ts6-beta13-metrics.txt`).
 */

export interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface PrometheusParseResult {
  samples: PrometheusSample[];
}

const SAMPLE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+(?:e[+-]?\d+)?)\s*(?:\d+)?\s*$/;

function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  const labels: Record<string, string> = {};
  // label_name="value" pairs; values may contain escaped quotes
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    labels[match[1]] = match[2]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return labels;
}

function parseValue(raw: string): number | null {
  const lower = raw.toLowerCase();
  if (lower === '+inf' || lower === 'inf') return Number.POSITIVE_INFINITY;
  if (lower === '-inf') return Number.NEGATIVE_INFINITY;
  if (lower === 'nan') return Number.NaN;
  const value = Number(raw);
  return Number.isFinite(value) || Number.isNaN(value) ? value : null;
}

/**
 * Parse a Prometheus text exposition body into samples.
 * Ignores `# HELP` / `# TYPE` / blank lines. Throws on empty body.
 */
export function parsePrometheusText(body: string): PrometheusParseResult {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error('Empty Prometheus exposition body');
  }

  const samples: PrometheusSample[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = SAMPLE_RE.exec(trimmed);
    if (!match) continue;

    const value = parseValue(match[3]);
    if (value === null) continue;

    samples.push({
      name: match[1],
      labels: parseLabels(match[2]),
      value,
    });
  }

  return { samples };
}
