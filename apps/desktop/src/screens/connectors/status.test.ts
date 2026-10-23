import { describe, expect, it } from 'vitest';
import type { Connector } from '@regis/shared';
import { listedConnectors } from './status';

function connector(name: string, transport: string): Connector {
  return {
    id: name,
    kind: name,
    name,
    transport,
    command: null,
    argsJson: [],
    url: null,
    envJson: {},
    secretRef: null,
    enabled: true,
    syncJson: {},
    status: 'unknown',
    lastSyncAt: null,
    createdAt: '2026-10-23T00:00:00Z',
  };
}

describe('listedConnectors', () => {
  it('hides builtin connectors and keeps the order of the others', () => {
    const listed = listedConnectors([
      connector('filesystem', 'stdio'),
      connector('brain', 'builtin'),
      connector('odoo', 'http'),
    ]);
    expect(listed.map((item) => item.name)).toEqual(['filesystem', 'odoo']);
  });
});
