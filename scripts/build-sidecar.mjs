import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PKG_NODE_MAJOR = 22;
const PKG_PLATFORMS = { win32: 'win', darwin: 'macos', linux: 'linux' };
const PKG_ARCHS = { x64: 'x64', arm64: 'arm64' };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(repoRoot, 'sidecar', '.build');
const binariesDir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'binaries');

function hostTargetTriple() {
  const result = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`rustc --print host-tuple failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function pkgTarget() {
  const platform = PKG_PLATFORMS[process.platform];
  const arch = PKG_ARCHS[process.arch];
  if (!platform || !arch) {
    throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
  }
  return `node${PKG_NODE_MAJOR}-${platform}-${arch}`;
}

const TARGETS = [
  { name: 'regis-sidecar', entry: join('sidecar', 'src', 'index.ts') },
  { name: 'regis-odoo-mcp', entry: join('sidecar', 'src', 'connectors', 'odoo-mcp', 'main.ts') },
];

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(binariesDir, { recursive: true });

const extension = process.platform === 'win32' ? '.exe' : '';
const pkgBin = join(repoRoot, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const triple = hostTargetTriple();

for (const { name, entry } of TARGETS) {
  const bundleFile = join(workDir, `${name}.cjs`);
  await build({
    entryPoints: [join(repoRoot, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${PKG_NODE_MAJOR}`,
    outfile: bundleFile,
  });

  const rawOutput = join(workDir, `${name}${extension}`);
  const pkgRun = spawnSync(
    process.execPath,
    [pkgBin, bundleFile, '--targets', pkgTarget(), '--output', rawOutput],
    { stdio: 'inherit', cwd: repoRoot },
  );
  if (pkgRun.status !== 0) {
    throw new Error(`pkg failed to compile ${name}`);
  }

  const finalPath = join(binariesDir, `${name}-${triple}${extension}`);
  rmSync(finalPath, { force: true });
  renameSync(rawOutput, finalPath);
  console.log(`Binary: ${finalPath}`);
}
