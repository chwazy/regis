import { describe, expect, it, vi } from 'vitest';
import { RpcErrorCode } from '@regis/shared';
import type { RpcMethodError } from '../server';
import { createBrainMethods } from './brain';

describe('brain rpc methods', () => {
  it('queues a brain cycle without waiting for it', async () => {
    const requestRun = vi.fn();
    const handlers = createBrainMethods({
      requestRun,
      refreshSynthesis: () => Promise.resolve(null),
      suggestEntityForFile: () => Promise.resolve([]),
    });

    const result = await handlers['brain.run']?.({});

    expect(result).toEqual({ started: true });
    expect(requestRun).toHaveBeenCalledOnce();
  });

  it('starts a synthesis refresh in the background and validates the parameters', async () => {
    const refreshSynthesis = vi.fn(() => new Promise<null>(() => undefined));
    const handlers = createBrainMethods({
      requestRun: () => undefined,
      refreshSynthesis,
      suggestEntityForFile: () => Promise.resolve([]),
    });

    expect(await handlers['brain.synthesize']?.({ entityId: 'E1' })).toEqual({ started: true });
    expect(refreshSynthesis).toHaveBeenCalledWith('E1');
    await expect(Promise.resolve().then(() => handlers['brain.synthesize']?.({}))).rejects.toThrow();
  });

  it('suggests entities for a file and validates the parameters', async () => {
    const suggestEntityForFile = vi.fn(() => Promise.resolve([{ entityId: 'E1', score: 0.8 }]));
    const handlers = createBrainMethods({
      requestRun: () => undefined,
      refreshSynthesis: () => Promise.resolve(null),
      suggestEntityForFile,
    });

    const suggestions = await handlers['brain.suggestEntity']?.({ fileId: 'f1', k: 2 });
    const invalid = await Promise.resolve(handlers['brain.suggestEntity']?.({})).catch(
      (error: unknown) => error,
    );

    expect(suggestions).toEqual([{ entityId: 'E1', score: 0.8 }]);
    expect(suggestEntityForFile).toHaveBeenCalledWith('f1', 2);
    expect((invalid as RpcMethodError).code).toBe(RpcErrorCode.InvalidParams);
  });
});
