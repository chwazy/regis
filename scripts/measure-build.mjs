import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { formatTable, parseArgs, summarize } from './measure-build-stats.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(repoRoot, 'apps', 'desktop', 'src-tauri');
const touchedFile = join(tauriDir, 'src', 'commands', 'settings.rs');

function fail(message) {
  console.error(`measure-build: ${message}`);
  process.exit(1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: repoRoot });
  return result.status === 0 ? result.stdout : null;
}

function runningProcesses() {
  const out =
    process.platform === 'win32'
      ? capture('tasklist', ['/FO', 'CSV', '/NH'])
      : capture('ps', ['-A', '-o', 'comm=']);
  if (out === null) return [];
  return out
    .split('\n')
    .map((l) => (process.platform === 'win32' ? (l.split('","')[0] ?? '') : l).replace(/"/g, ''))
    .map((n) =>
      n
        .trim()
        .toLowerCase()
        .replace(/\.exe$/, ''),
    );
}

function assertNoBuildRunning() {
  const busy = new Set(
    runningProcesses().filter((n) => n === 'cargo' || n === 'regis-desktop' || n.endsWith('/cargo')),
  );
  if (busy.size > 0) {
    fail(`processus en cours (${[...busy].join(', ')}) : arrêter cargo / l'app de dev avant de mesurer.`);
  }
}

function configuredLinker() {
  const configPath = join(repoRoot, '.cargo', 'config.toml');
  if (!existsSync(configPath)) return 'default';
  const match = /^\s*linker\s*=\s*"([^"]+)"/m.exec(readFileSync(configPath, 'utf8'));
  return match ? match[1] : 'default';
}

function cargo(args, env, timings) {
  const full = [...args, ...(timings ? ['--timings'] : [])];
  const start = performance.now();
  const result = spawnSync('cargo', full, {
    cwd: tauriDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const seconds = (performance.now() - start) / 1000;
  if (result.status !== 0) {
    console.error(result.stderr);
    throw new Error(`cargo ${full.join(' ')} a échoué (code ${result.status ?? 'signal'})`);
  }
  return seconds;
}

function touch() {
  const now = new Date();
  utimesSync(touchedFile, now, now);
}

function incremental(name, args, runs, timings) {
  const warmup = args[0] === 'test' ? ['test', '--no-run'] : ['build'];
  cargo(warmup, {}, false);
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    cargo(warmup, {}, false);
    touch();
    samples.push(cargo(args, {}, timings));
  }
  return summarize(name, samples);
}

function full(runs, timings) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'));
    try {
      samples.push(cargo(['build'], { CARGO_TARGET_DIR: dir }, timings));
      if (timings) {
        const kept = join(tmpdir(), `hb-timing-${i + 1}.html`);
        copyFileSync(join(dir, 'cargo-timings', 'cargo-timing.html'), kept);
        console.log(`Rapport timings : ${kept}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return summarize('full', samples);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}

assertNoBuildRunning();

const rustc = (capture('rustc', ['--version']) ?? 'inconnu').trim().split(' ')[1] ?? 'inconnu';
const rows = [];
try {
  if (options.full) {
    rows.push(full(options.runs, options.timings));
  } else {
    rows.push(incremental('incremental-command', ['build'], options.runs, options.timings));
    rows.push(incremental('incremental-test', ['test', '--no-run'], options.runs, options.timings));
  }
} catch (error) {
  fail(error.message);
}

if (options.timings && !options.full) {
  console.log(
    `Rapport timings : ${join(tauriDir, 'target', 'cargo-timings', 'cargo-timing.html')} (scénarios incrémentaux)`,
  );
}

const report = {
  rustc,
  linker: configuredLinker(),
  rustcWrapper: process.env.RUSTC_WRAPPER || null,
  cpus: cpus().length,
  ramGb: Math.round(totalmem() / 1024 ** 3),
  results: rows,
};

console.log(
  `rustc ${report.rustc} | linker ${report.linker} | RUSTC_WRAPPER ${report.rustcWrapper ?? 'absent'} | ${report.cpus} cœurs | ${report.ramGb} Go\n`,
);
console.log(formatTable(rows));
console.log(`\n${JSON.stringify(report, null, 2)}`);
