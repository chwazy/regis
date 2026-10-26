import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRIDGE_PORT = '1430';
const DEMO_DATA_DIR_NAME = 'regis-demo';
const DEMO_AGENT_DELAY_MS = '300';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const debug = process.argv.includes('--debug');
const onboarding = process.argv.includes('--onboarding');

function demoEnv() {
  const dataDir = join(tmpdir(), DEMO_DATA_DIR_NAME);
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`Mode démo : base réinitialisée dans ${dataDir}`);
  return {
    REGIS_DEMO: '1',
    REGIS_DATA_DIR: dataDir,
    REGIS_CLAUDE_BIN: join(repoRoot, 'tests', 'fake-bins', 'claude.mjs'),
    FAKE_CLAUDE_FIXTURE: join(repoRoot, 'tests', 'fixtures', 'demo', 'agent-reply.ndjson'),
    FAKE_CLAUDE_MINUTES_FIXTURE: join(repoRoot, 'tests', 'fixtures', 'demo', 'minutes-reply.ndjson'),
    FAKE_CLAUDE_DELAY_MS: DEMO_AGENT_DELAY_MS,
  };
}

function debugEnv() {
  console.log('Mode debug : backtraces Rust et source maps Node activées');
  return {
    RUST_BACKTRACE: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' '),
  };
}

// rustup installe dans ~/.cargo/bin ; un shell lancé avant l'installation ne l'a pas dans son PATH.
// Sous Windows la clé s'appelle souvent « Path » : on réécrit la clé existante, sans doublon.
function cargoPathEnv() {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = process.env[key] ?? '';
  const cargoBin = join(homedir(), '.cargo', 'bin');
  if (!existsSync(cargoBin) || current.split(delimiter).includes(cargoBin)) {
    return {};
  }
  return { [key]: [cargoBin, current].join(delimiter) };
}

const env = {
  ...process.env,
  ...cargoPathEnv(),
  REGIS_DEV_BRIDGE_PORT: process.env.REGIS_DEV_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT,
  REGIS_DEV_BRIDGE_TOKEN: randomBytes(32).toString('hex'),
  ...(demo ? demoEnv() : {}),
  ...(debug ? debugEnv() : {}),
  ...(onboarding ? { REGIS_FORCE_ONBOARDING: '1' } : {}),
};

function run(npmArgs) {
  return new Promise((resolve) => {
    const child = spawn(`npm ${npmArgs}`, { env, stdio: 'inherit', shell: true });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const buildCode = await run('run build:dev -w @regis/sidecar');
if (buildCode !== 0) {
  process.exit(buildCode);
}
process.exit(await run('run tauri -w @regis/desktop -- dev'));
