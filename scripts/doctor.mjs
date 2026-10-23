import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { sccacheState } from './doctor-sccache.mjs';

const MIN_NODE = [22, 22];
const MIN_RUST = [1, 90];
const MIN_CONPTY_BUILD = 17763;
const OLLAMA_MODEL = 'bge-m3';
const OLLAMA_USAGE = 'optionnel : recherche sémantique et agent de chat local';
const WEBVIEW2_CLIENT_KEY = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
// whisper-rs-sys (générateur Visual Studio) crée sous le dossier target des fichiers jusqu'à
// ~150 caractères plus bas ; le FileTracker de MSBuild échoue au-delà de MAX_PATH (260),
// même avec LongPathsEnabled.
const MAX_TARGET_DIR_LENGTH = 100;
const TAURI_MANIFEST = join('apps', 'desktop', 'src-tauri', 'Cargo.toml');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: isWindows, timeout: 15000 });
  if (result.error || result.status !== 0) {
    return null;
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { ok, detail: `v${process.versions.node} (>= ${MIN_NODE.join('.')} requis)` };
}

function checkRust() {
  const output = run('rustc', ['--version']);
  if (!output) {
    return { ok: false, detail: 'rustc introuvable (installer rustup)' };
  }
  const match = /rustc (\d+)\.(\d+)/.exec(output);
  const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  const ok = major > MIN_RUST[0] || (major === MIN_RUST[0] && minor >= MIN_RUST[1]);
  return { ok, detail: `${output} (>= ${MIN_RUST.join('.')} requis)` };
}

function findVswhere() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  return roots
    .map((root) => join(root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'))
    .find((candidate) => existsSync(candidate));
}

function findVsInstallation() {
  const vswhere = findVswhere();
  return vswhere
    ? run(`"${vswhere}"`, [
        '-products',
        '*',
        '-latest',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ])
    : null;
}

function checkCToolchain() {
  if (isWindows) {
    const installation = findVsInstallation();
    return installation
      ? { ok: true, detail: `MSVC Build Tools (${installation})` }
      : { ok: false, detail: 'Visual Studio Build Tools avec le composant C++ introuvables' };
  }
  if (isMac) {
    const path = run('xcode-select', ['-p']);
    return path
      ? { ok: true, detail: `Xcode Command Line Tools (${path})` }
      : { ok: false, detail: 'Xcode Command Line Tools introuvables (xcode-select --install)' };
  }
  const compiler = run('cc', ['--version']);
  const webkit = run('pkg-config', ['--modversion', 'webkit2gtk-4.1']);
  if (!compiler) {
    return { ok: false, detail: 'compilateur C (cc) introuvable' };
  }
  return webkit
    ? { ok: true, detail: `cc + webkit2gtk-4.1 ${webkit}` }
    : { ok: false, detail: 'webkit2gtk-4.1 introuvable (voir les prérequis Tauri pour Linux)' };
}

function bundledCmake() {
  // Hors PATH, la crate cmake (whisper-rs-sys) utilise le cmake fourni avec Visual Studio.
  const installation = isWindows ? findVsInstallation() : null;
  const candidate = installation
    ? join(
        installation,
        'Common7',
        'IDE',
        'CommonExtensions',
        'Microsoft',
        'CMake',
        'CMake',
        'bin',
        'cmake.exe',
      )
    : null;
  return candidate && existsSync(candidate) ? candidate : null;
}

function checkCmake() {
  const output = run('cmake', ['--version']);
  if (output) {
    return { ok: true, detail: output.split('\n')[0] };
  }
  const bundled = bundledCmake();
  const bundledOutput = bundled ? run(`"${bundled}"`, ['--version']) : null;
  if (bundledOutput) {
    return { ok: true, detail: `${bundledOutput.split('\n')[0]} (fourni avec Visual Studio)` };
  }
  return {
    ok: false,
    detail: 'cmake introuvable (requis pour compiler whisper-rs ; https://cmake.org/download)',
  };
}

function libclangCandidates() {
  const fromEnv = process.env.LIBCLANG_PATH ? [process.env.LIBCLANG_PATH] : [];
  if (isWindows) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    return [...fromEnv, ...roots.map((root) => join(root, 'LLVM', 'bin'))];
  }
  if (isMac) {
    return [
      ...fromEnv,
      '/opt/homebrew/opt/llvm/lib',
      '/usr/local/opt/llvm/lib',
      '/Library/Developer/CommandLineTools/usr/lib',
    ];
  }
  const versioned = ['14', '15', '16', '17', '18', '19', '20'].map(
    (version) => `/usr/lib/llvm-${version}/lib`,
  );
  return [...fromEnv, ...versioned, '/usr/lib', '/usr/lib64', '/usr/lib/x86_64-linux-gnu'];
}

function checkLibclang() {
  const names = isWindows ? ['libclang.dll'] : isMac ? ['libclang.dylib'] : ['libclang.so', 'libclang.so.1'];
  const found = libclangCandidates()
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .find((candidate) => existsSync(candidate));
  return found
    ? { ok: true, detail: found }
    : {
        ok: false,
        detail:
          'libclang introuvable (installer LLVM, requis pour compiler whisper-rs ; définir LIBCLANG_PATH si besoin)',
      };
}

function checkTargetDir() {
  const output = run('cargo', [
    'metadata',
    '--no-deps',
    '--format-version',
    '1',
    '--manifest-path',
    TAURI_MANIFEST,
  ]);
  if (!output) {
    return { ok: false, detail: 'cargo metadata a échoué (dossier target inconnu)' };
  }
  const targetDir = JSON.parse(output.slice(output.indexOf('{'))).target_directory;
  const ok = targetDir.length <= MAX_TARGET_DIR_LENGTH;
  return {
    ok,
    detail: ok
      ? `${targetDir.length} caractères (<= ${MAX_TARGET_DIR_LENGTH})`
      : `${targetDir} : ${targetDir.length} caractères (> ${MAX_TARGET_DIR_LENGTH}), le build CMake de whisper-rs échouera ; raccourcir CARGO_TARGET_DIR`,
  };
}

function checkWebView2() {
  const keys = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_KEY}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_KEY}`,
    `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT_KEY}`,
  ];
  for (const key of keys) {
    const output = run('reg', ['query', `"${key}"`, '/v', 'pv']);
    const version = output && /pv\s+REG_SZ\s+(\S+)/.exec(output)?.[1];
    if (version && version !== '0.0.0.0') {
      return { ok: true, detail: `WebView2 Runtime ${version}` };
    }
  }
  return { ok: false, detail: 'WebView2 Runtime introuvable' };
}

function checkConPty() {
  const build = Number(release().split('.')[2]);
  const ok = build >= MIN_CONPTY_BUILD;
  return { ok, detail: `Windows build ${build} (>= ${MIN_CONPTY_BUILD} requis pour le terminal ConPTY)` };
}

async function checkOllama() {
  const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    const names = (body.models ?? []).map((model) => model.name);
    return { ok: true, detail: `joignable (${base}), ${names.length} modèle(s)`, models: names };
  } catch {
    return { ok: false, detail: `injoignable (${base}) : lancer Ollama`, models: [] };
  }
}

function checkClaude() {
  const bin = process.env.REGIS_CLAUDE_BIN || 'claude';
  const output = run(/\s/.test(bin) ? `"${bin}"` : bin, ['--version']);
  return output
    ? { ok: true, detail: output.split('\n')[0] }
    : { ok: false, detail: 'CLI claude introuvable (PATH ou REGIS_CLAUDE_BIN)' };
}

function checkWord() {
  if (!isWindows) {
    return { ok: false, detail: 'export PDF des modèles disponible sous Windows avec Word uniquement' };
  }
  const result = spawnSync('reg.exe', ['query', 'HKCR\\Word.Application\\CurVer'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return result.status === 0
    ? { ok: true, detail: (result.stdout.match(/Word\.Application\.\d+/) ?? ['Word.Application'])[0] }
    : { ok: false, detail: 'Word introuvable : modèles générés en DOCX seulement (export PDF masqué)' };
}

function checkSccache() {
  const onPath = run('sccache', ['--version']) !== null;
  const state = sccacheState(process.env, onPath);
  if (state === 'active') {
    const wrapper = process.env.RUSTC_WRAPPER;
    return onPath || existsSync(wrapper)
      ? { ok: true, detail: 'actif (RUSTC_WRAPPER) · optionnel : cache de compilation' }
      : {
          ok: false,
          detail: 'RUSTC_WRAPPER pointe vers sccache introuvable : retirer la variable ou installer sccache',
        };
  }
  return state === 'installed-inactive'
    ? {
        ok: false,
        detail: 'installé mais inactif (définir RUSTC_WRAPPER=sccache) · optionnel : cache de compilation',
      }
    : { ok: false, detail: 'absent · optionnel : cache de compilation (voir docs/development.md)' };
}

function checkModel(models) {
  const ok = models.some((name) => name === OLLAMA_MODEL || name.startsWith(`${OLLAMA_MODEL}:`));
  return { ok, detail: ok ? 'présent' : `absent : ollama pull ${OLLAMA_MODEL} (recherche sémantique)` };
}

const ollama = await checkOllama();
const checks = [
  { name: 'Node.js', required: true, ...checkNode() },
  { name: 'Rust', required: true, ...checkRust() },
  { name: 'Toolchain C', required: true, ...checkCToolchain() },
  { name: 'cmake', required: true, ...checkCmake() },
  { name: 'libclang (LLVM)', required: true, ...checkLibclang() },
  ...(isWindows ? [{ name: 'Dossier target', required: true, ...checkTargetDir() }] : []),
  ...(isWindows ? [{ name: 'WebView2', required: true, ...checkWebView2() }] : []),
  ...(isWindows ? [{ name: 'ConPTY', required: true, ...checkConPty() }] : []),
  { name: 'Ollama', required: false, ok: ollama.ok, detail: `${ollama.detail} · ${OLLAMA_USAGE}` },
  { name: `Modèle ${OLLAMA_MODEL}`, required: false, ...checkModel(ollama.models) },
  { name: 'CLI Claude Code', required: false, ...checkClaude() },
  { name: 'Word (export PDF)', required: false, ...checkWord() },
  { name: 'sccache', required: false, ...checkSccache() },
];

for (const check of checks) {
  const status = check.ok ? 'OK' : 'KO';
  const suffix = !check.ok && !check.required ? ' [avertissement]' : '';
  console.log(`[${status}] ${check.name.padEnd(18)} ${check.detail}${suffix}`);
}

const missingRequired = checks.filter((check) => check.required && !check.ok);
process.exit(missingRequired.length > 0 ? 1 : 0);
