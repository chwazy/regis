import type { Job } from '@regis/shared';
import { isActive } from './job-view';

export interface JobTreeNode {
  job: Job;
  depth: number;
}

export function buildJobTree(jobs: Job[], currentId: string | undefined): JobTreeNode[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const children = new Map<string, Job[]>();
  for (const job of jobs) {
    if (job.parentId !== null && byId.has(job.parentId)) {
      children.set(job.parentId, [...(children.get(job.parentId) ?? []), job]);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  const visible = new Set<string>();
  const markWithAncestors = (job: Job): void => {
    let cursor: Job | undefined = job;
    while (cursor && !visible.has(cursor.id)) {
      visible.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  };
  const markWithDescendants = (job: Job): void => {
    visible.add(job.id);
    for (const child of children.get(job.id) ?? []) {
      markWithDescendants(child);
    }
  };
  for (const job of jobs) {
    if (isActive(job.status)) {
      markWithAncestors(job);
      markWithDescendants(job);
    }
  }
  const current = currentId === undefined ? undefined : byId.get(currentId);
  if (current) {
    markWithAncestors(current);
    let root: Job = current;
    while (root.parentId !== null && byId.has(root.parentId)) {
      root = byId.get(root.parentId) as Job;
    }
    markWithDescendants(root);
  }

  const roots = jobs
    .filter((job) => visible.has(job.id) && (job.parentId === null || !byId.has(job.parentId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const ordered: JobTreeNode[] = [];
  const walk = (job: Job, depth: number): void => {
    ordered.push({ job, depth });
    for (const child of children.get(job.id) ?? []) {
      if (visible.has(child.id)) {
        walk(child, depth + 1);
      }
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return ordered;
}
