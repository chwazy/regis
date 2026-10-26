import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import spawn from 'cross-spawn';
import { DriverUnavailableError } from './driver';

export const FIXTURE_CLAUDE_VERSION = '2.1.306';
export const CLAUDE_BIN_ENV = 'REGIS_CLAUDE_BIN';
export const CLAUDE_BIN_SETTING = 'agents.claudeBin';

const VERSION_TIMEOUT_MS = 10_000;
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat'];
const NODE_SCRIPT = /\.[cm]?js$/i;

export function claudeCommand(bin: string, args: string[]): { command: string; args: string[] } {
  return NODE_SCRIPT.test(bin) ? { command: process.execPath, args: [bin, ...args] } : { command: bin, args };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function withExecutableExtension(path: string): string | undefined {
  if (isFile(path) && (process.platform !== 'win32' || /\.[a-z]+$/i.test(path))) {
    return path;
  }
  if (process.platform !== 'win32') {
    return undefined;
  }
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${path}${extension}`).find(isFile);
}

export function locateOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter((entry) => entry !== '');
  for (const directory of directories) {
    const found = withExecutableExtension(join(directory, name));
    if (found) {
      return found;
    }
  }
  return undefined;
}

export interface ClaudeBinSources {
  getSetting: (key: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}

export async function resolveClaudeBin(sources: ClaudeBinSources): Promise<string> {
  const env = sources.env ?? process.env;
  const configured = env[CLAUDE_BIN_ENV] || (await sources.getSetting(CLAUDE_BIN_SETTING)) || undefined;
  if (configured) {
    const candidate = isAbsolute(configured) || /[\\/]/.test(configured) ? resolve(configured) : configured;
    const found = /[\\/]/.test(configured)
      ? withExecutableExtension(candidate)
      : locateOnPath(configured, env);
    if (!found || !existsSync(found)) {
      throw new DriverUnavailableError(`Exécutable Claude Code introuvable : ${configured}`);
    }
    return found;
  }
  const onPath = locateOnPath('claude', env);
  if (!onPath) {
    throw new DriverUnavailableError('Claude Code est introuvable dans le PATH (réglage agents.claudeBin)');
  }
  return onPath;
}

export function readClaudeVersion(bin: string): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    const command = claudeCommand(bin, ['--version']);
    const child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new DriverUnavailableError('claude --version : délai dépassé'));
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new DriverUnavailableError(`Impossible de lancer ${bin} : ${error.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const version = /\d+\.\d+\.\d+/.exec(output)?.[0];
      if (version) {
        resolveVersion(version);
      } else {
        reject(new DriverUnavailableError(`${bin} ne renvoie pas de version Claude Code`));
      }
    });
  });
}
