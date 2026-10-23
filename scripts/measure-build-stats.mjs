export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(name, seconds) {
  return {
    scenario: name,
    runs: seconds.length,
    median: median(seconds),
    min: Math.min(...seconds),
    max: Math.max(...seconds),
  };
}

export function parseArgs(argv) {
  const options = { runs: 3, full: false, timings: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') options.full = true;
    else if (arg === '--timings') options.timings = true;
    else if (arg === '--runs') {
      const raw = argv[i + 1];
      i += 1;
      const runs = Number(raw);
      if (raw === undefined || !Number.isInteger(runs) || runs < 1) {
        throw new Error(`--runs attend un entier >= 1 (reçu : ${raw})`);
      }
      options.runs = runs;
    } else {
      throw new Error(`option inconnue : ${arg}`);
    }
  }
  return options;
}

export function formatTable(rows) {
  const header = ['scénario', 'runs', 'médiane (s)', 'min (s)', 'max (s)'];
  const body = rows.map((r) => [
    r.scenario,
    String(r.runs),
    r.median.toFixed(2),
    r.min.toFixed(2),
    r.max.toFixed(2),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
