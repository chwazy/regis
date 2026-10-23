import { describe, expect, it } from 'vitest';
import { RpcErrorCode } from '@regis/shared';
import { NoEligibleAgentError } from '../../routing/engine';
import type { RpcMethodError } from '../server';
import { createRoutingMethods } from './routing';

describe('routing.preview', () => {
  it('returns the decision of the routing service', async () => {
    const seen: unknown[] = [];
    const handlers = createRoutingMethods((request) => {
      seen.push(request);
      return Promise.resolve({ agentId: 'a', ruleId: null, reason: 'r', viaFallback: true });
    });

    const result = await handlers['routing.preview']?.({
      task: 'écrire',
      taskType: 'redaction',
      clientId: 'c1',
    });

    expect(result).toEqual({ agentId: 'a', ruleId: null, reason: 'r', viaFallback: true });
    expect(seen).toEqual([{ task: 'écrire', taskType: 'redaction', clientId: 'c1', source: 'task' }]);
  });

  it('maps invalid params and missing agents to RPC errors', async () => {
    const handlers = createRoutingMethods(() => Promise.reject(new NoEligibleAgentError('aucun')));

    const invalid = await Promise.resolve(handlers['routing.preview']?.({})).catch((error: unknown) => error);
    const unavailable = await Promise.resolve(handlers['routing.preview']?.({ task: 't' })).catch(
      (error: unknown) => error,
    );

    expect((invalid as RpcMethodError).code).toBe(RpcErrorCode.InvalidParams);
    expect((unavailable as RpcMethodError).code).toBe(RpcErrorCode.Unavailable);
  });
});
