import { afterEach, describe, expect, it } from 'vitest';
import { makeAgent } from '../agents/test-support';
import { createTestRunner, type TestRunner } from '../jobs/test-support';
import {
  chatSystemPrompt,
  createChat,
  ChatError,
  NON_DELEGATING_SYSTEM_PROMPT,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from './chat';

const created: TestRunner[] = [];

function setup(settings: Record<string, string> = {}) {
  const testRunner = createTestRunner({
    settings,
    agents: [makeAgent({ id: 'first' }), makeAgent({ id: 'second' })],
    systemPromptFor: chatSystemPrompt,
  });
  created.push(testRunner);
  const chat = createChat({
    runner: testRunner.runner,
    getJob: (id) => testRunner.store.getJob(id),
    listAgents: () => Promise.resolve([...testRunner.agents.values()]),
    getSetting: (key) => Promise.resolve(settings[key] ?? null),
  });
  return { testRunner, chat };
}

describe('orchestrator chat', () => {
  afterEach(() => {
    for (const testRunner of created.splice(0)) {
      testRunner.cleanup();
    }
  });

  it('creates the chat job on the first message and resumes the same job afterwards', async () => {
    const { testRunner, chat } = setup({ 'agents.defaultAgentId': 'second' });

    const first = await chat.send({ text: 'Prépare l’offre\nDétails' });
    expect(first).toMatchObject({ kind: 'chat', agentId: 'second', prompt: 'Prépare l’offre\nDétails' });
    expect(first.title).toBe('Orchestrateur — Prépare l’offre');
    await testRunner.runner.waitForEnd(first.id);

    const second = await chat.send({ chatJobId: first.id, text: 'Et ensuite ?' });
    await testRunner.runner.waitForEnd(first.id);

    expect(second.id).toBe(first.id);
    expect(testRunner.store.jobs.size).toBe(1);
    expect(testRunner.store.statusHistory.get(first.id)).toEqual([
      'queued',
      'running',
      'done',
      'queued',
      'running',
      'done',
    ]);
  });

  it('falls back to the first enabled agent and rejects empty or non-chat targets', async () => {
    const { testRunner, chat } = setup();

    const job = await chat.send({ text: 'hello' });
    await testRunner.runner.waitForEnd(job.id);
    const task = await testRunner.runner.start({ agentId: 'first', title: 'T', prompt: 'p' });
    await testRunner.runner.waitForEnd(task.id);

    expect(job.agentId).toBe('first');
    await expect(chat.send({ text: '   ' })).rejects.toBeInstanceOf(ChatError);
    await expect(chat.send({ chatJobId: task.id, text: 'x' })).rejects.toBeInstanceOf(ChatError);
  });

  it('gives only chat jobs the orchestrator system prompt', () => {
    const spawner = { canSpawn: true } as never;
    expect(chatSystemPrompt({ kind: 'chat' } as never, spawner)).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    expect(chatSystemPrompt({ kind: 'task' } as never, spawner)).toBeUndefined();
  });

  it('does not tell an agent without can_spawn to use spawn_job', () => {
    const prompt = chatSystemPrompt({ kind: 'chat' } as never, { canSpawn: false } as never);

    expect(prompt).toBe(NON_DELEGATING_SYSTEM_PROMPT);
    expect(prompt).not.toContain('spawn_job');
  });
});
