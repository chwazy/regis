import { describe, expect, it } from 'vitest';
import type { Connector, ConnectorStatus } from '@regis/shared';
import { sourceErrorMessage, sourceIssues } from './source-status';

function connector(id: string, kind: string, status: string, enabled = true): Connector {
  return { id, kind, status, enabled } as Connector;
}

function liveStatus(connectorId: string, state: ConnectorStatus['state'], error?: string): ConnectorStatus {
  return { connectorId, state, toolCount: 0, since: '2026-10-22T08:00:00.000Z', ...(error ? { error } : {}) };
}

describe('sourceErrorMessage', () => {
  it('is silent when the connector of that source is healthy', () => {
    expect(sourceErrorMessage([connector('c1', 'odoo', 'connected')], {}, 'odoo')).toBeNull();
  });

  it('reports a connector whose stored status is error', () => {
    expect(sourceErrorMessage([connector('c1', 'odoo', 'error')], {}, 'odoo')).toContain('Odoo');
  });

  it('prefers the live status and includes its detail', () => {
    const message = sourceErrorMessage(
      [connector('c1', 'm365', 'connected')],
      { c1: liveStatus('c1', 'error', 'token expiré') },
      'm365',
    );
    expect(message).toContain('token expiré');
    expect(
      sourceErrorMessage([connector('c1', 'm365', 'error')], { c1: liveStatus('c1', 'connected') }, 'm365'),
    ).toBeNull();
  });

  it('ignores other sources and disabled connectors', () => {
    expect(sourceErrorMessage([connector('c1', 'm365', 'error')], {}, 'odoo')).toBeNull();
    expect(sourceErrorMessage([connector('c1', 'odoo', 'error', false)], {}, 'odoo')).toBeNull();
  });
});

describe('sourceIssues', () => {
  const kinds: ('m365' | 'odoo')[] = ['m365', 'odoo'];

  it('flags a failing Odoo connector', () => {
    const issues = sourceIssues([connector('o1', 'odoo', 'error')], {}, kinds);
    expect(issues.errors).toHaveLength(1);
    expect(issues.errors[0]).toContain('Odoo');
  });

  it('keeps the data when only one of two configured sources fails', () => {
    const issues = sourceIssues(
      [connector('m1', 'm365', 'connected'), connector('o1', 'odoo', 'error')],
      {},
      kinds,
    );
    expect(issues).toMatchObject({ allFailing: false });
    expect(issues.errors).toHaveLength(1);
  });

  it('hides the data when every configured source fails', () => {
    const issues = sourceIssues(
      [connector('m1', 'm365', 'error'), connector('o1', 'odoo', 'error')],
      {},
      kinds,
    );
    expect(issues).toMatchObject({ allFailing: true });
    expect(issues.errors).toHaveLength(2);
  });

  it('treats a single configured failing source as failing even if the other kind is absent', () => {
    expect(sourceIssues([connector('m1', 'm365', 'error')], {}, kinds).allFailing).toBe(true);
  });

  it('reports nothing when all sources are healthy', () => {
    expect(sourceIssues([connector('m1', 'm365', 'connected')], {}, kinds)).toEqual({
      errors: [],
      allFailing: false,
    });
  });
});
