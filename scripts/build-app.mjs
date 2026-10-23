import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLES_BY_PLATFORM = {
  win32: ['nsis'],
  darwin: ['app', 'dmg'],
  linux: ['appimage', 'deb'],
};
const EXTERNAL_BINARIES = ['regis-sidecar', 'regis-odoo-mcp'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(repoRoot, 'apps', 'desktop', 'src-tauri');

function fail(message) {
  console.error(`build-app: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: process.platform === 'win32' && command === 'npm',
    ...options,
  });
  if (result.status !== 0) {
    fail(`échec de « ${command} ${args.join(' ')} » (code ${result.status ?? 'signal'})`);
  }
}

const bundles = BUNDLES_BY_PLATFORM[process.platform];
if (!bundles) fail(`plateforme non supportée : ${process.platform}`);

run(process.execPath, [join(repoRoot, 'scripts', 'build-sidecar.mjs')]);

const triple = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' });
if (triple.status !== 0) fail(`rustc --print host-tuple a échoué : ${triple.stderr}`);
const extension = process.platform === 'win32' ? '.exe' : '';
const missing = EXTERNAL_BINARIES.map((name) =>
  join(tauriDir, 'binaries', `${name}-${triple.stdout.trim()}${extension}`),
).filter((file) => !existsSync(file));
if (missing.length > 0) {
  fail(`binaire(s) externalBin manquant(s) :\n  ${missing.join('\n  ')}`);
}

run('npm', ['run', 'tauri', '-w', '@regis/desktop', '--', 'build', '--bundles', bundles.join(',')]);

const bundleRoot = join(tauriDir, 'target', 'release', 'bundle');
console.log('\nArtefacts :');
for (const entry of existsSync(bundleRoot) ? readdirSync(bundleRoot) : []) {
  const dir = join(bundleRoot, entry);
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    console.log(`  ${join(dir, file.name)}`);
  }
}
