import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export interface WorkdirRequest {
  dataDir: string;
  jobId: string;
  worktree: boolean;
  repoPath?: string;
  cwd?: string;
}

export interface WorktreeInfo {
  repoPath: string;
  branch: string;
}

export interface Workdir {
  jobDir: string;
  cwd: string;
  worktree: WorktreeInfo | null;
}

export interface CleanupResult {
  removed: boolean;
  reason?: string;
}

export function jobDirectory(dataDir: string, jobId: string): string {
  return join(dataDir, 'jobs', jobId);
}

export async function prepareWorkdir(request: WorkdirRequest): Promise<Workdir> {
  const jobDir = jobDirectory(request.dataDir, request.jobId);
  await mkdir(jobDir, { recursive: true });
  if (request.worktree && request.repoPath && (await isGitRepository(request.repoPath))) {
    const alreadyPopulated = (await readdir(jobDir)).length > 0;
    const branch = `regis/job-${request.jobId}`;
    if (!alreadyPopulated) {
      await git(request.repoPath, ['worktree', 'add', '-b', branch, jobDir]);
    }
    return { jobDir, cwd: jobDir, worktree: { repoPath: resolve(request.repoPath), branch } };
  }
  return { jobDir, cwd: request.cwd ?? jobDir, worktree: null };
}

export async function cleanupWorktree(jobDir: string): Promise<CleanupResult> {
  if (!existsSync(join(jobDir, '.git')) || !(await isGitRepository(jobDir))) {
    return { removed: false, reason: 'Ce dossier n’est pas un worktree git' };
  }
  const status = await git(jobDir, ['status', '--porcelain']);
  if (status.trim() !== '') {
    return { removed: false, reason: 'Le worktree contient des modifications non enregistrées' };
  }
  const commonDir = (await git(jobDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  await execFileAsync('git', [`--git-dir=${commonDir}`, 'worktree', 'remove', jobDir], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return { removed: true };
}

async function isGitRepository(directory: string): Promise<boolean> {
  try {
    await git(directory, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', directory, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}
