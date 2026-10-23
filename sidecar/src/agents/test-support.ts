import type { Agent } from '@regis/shared';
import type { AgentRunInput } from './driver';

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'Test agent',
    runtime: 'claude-cli',
    mode: 'headless',
    accountLabel: null,
    model: null,
    budgetDailyUsd: null,
    useWhen: '',
    canSpawn: false,
    worktreePerJob: false,
    connectorIdsJson: [],
    secretRef: null,
    isLocalOnly: false,
    enabled: true,
    ...overrides,
  };
}

export function makeRunInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    jobId: 'j1',
    agent: makeAgent(),
    prompt: 'hello',
    cwd: process.cwd(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
