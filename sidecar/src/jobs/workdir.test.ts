import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorktree, prepareWorkdir } from './workdir';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): void {
  execFileSync('git', ['-C', directory, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    stdio: 'ignore',
  });
}

function makeRepository(): string {
  const repository = tempDir('regis-repo-');
  git(repository, 'init');
  writeFileSync(join(repository, 'a.txt'), 'a');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'init');
  return repository;
}

describe('prepareWorkdir', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('creates a git worktree in <data_dir>/jobs/<id> when asked and the repository is valid', async () => {
    const dataDir = tempDir('regis-data-');
    const repoPath = makeRepository();

    const workdir = await prepareWorkdir({ dataDir, jobId: 'J1', worktree: true, repoPath });

    expect(workdir.jobDir).toBe(join(dataDir, 'jobs', 'J1'));
    expect(workdir.cwd).toBe(workdir.jobDir);
    expect(existsSync(join(workdir.jobDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(workdir.jobDir, '.git'))).toBe(true);
    expect(workdir.worktree?.branch).toBe('regis/job-J1');
  });

  it('creates an empty folder without error when there is no git repository', async () => {
    const dataDir = tempDir('regis-data-');
    const notARepository = tempDir('regis-plain-');

    const workdir = await prepareWorkdir({ dataDir, jobId: 'J2', worktree: true, repoPath: notARepository });
    const withoutRepo = await prepareWorkdir({ dataDir, jobId: 'J3', worktree: true });

    expect(readdirSync(workdir.jobDir)).toEqual([]);
    expect(workdir.worktree).toBeNull();
    expect(withoutRepo.worktree).toBeNull();
    expect(existsSync(withoutRepo.jobDir)).toBe(true);
  });

  it('does not create a worktree when the agent does not ask for one', async () => {
    const dataDir = tempDir('regis-data-');
    const repoPath = makeRepository();

    const workdir = await prepareWorkdir({ dataDir, jobId: 'J4', worktree: false, repoPath });

    expect(workdir.worktree).toBeNull();
    expect(readdirSync(workdir.jobDir)).toEqual([]);
  });

  it('refuses to clean a worktree with uncommitted work and removes a clean one', async () => {
    const dataDir = tempDir('regis-data-');
    const repoPath = makeRepository();
    const { jobDir } = await prepareWorkdir({ dataDir, jobId: 'J5', worktree: true, repoPath });
    writeFileSync(join(jobDir, 'new.txt'), 'work in progress');

    const refused = await cleanupWorktree(jobDir);
    rmSync(join(jobDir, 'new.txt'));
    const removed = await cleanupWorktree(jobDir);

    expect(refused.removed).toBe(false);
    expect(existsSync(join(jobDir, 'new.txt'))).toBe(false);
    expect(removed.removed).toBe(true);
    expect(existsSync(jobDir)).toBe(false);
  });
});
