import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_API_KEY,
  FAKE_DB,
  FAKE_LOGIN,
  FAKE_UID,
  startFakeOdoo,
  type FakeOdoo,
} from '../../../../tests/servers/fake-odoo.mjs';
import { OdooAuthError, OdooClient, OdooRpcError } from './client';

let odoo: FakeOdoo;

beforeAll(async () => {
  odoo = await startFakeOdoo({ missingModels: ['account.analytic.line'] });
});

afterAll(async () => {
  await odoo.close();
});

function clientWith(apiKey: string): OdooClient {
  return new OdooClient({ url: odoo.url, db: FAKE_DB, login: FAKE_LOGIN, apiKey });
}

describe('OdooClient', () => {
  it('authenticates and returns the uid', async () => {
    await expect(clientWith(FAKE_API_KEY).authenticate()).resolves.toBe(FAKE_UID);
  });

  it('throws OdooAuthError on an invalid API key', async () => {
    await expect(clientWith('wrong').authenticate()).rejects.toBeInstanceOf(OdooAuthError);
  });

  it('runs search_read through execute_kw', async () => {
    const rows = await clientWith(FAKE_API_KEY).searchRead<{ id: number }>('project.project', [], ['name']);
    expect(rows.map((row) => row.id)).toEqual([3]);
  });

  it('surfaces server errors as OdooRpcError', async () => {
    await expect(
      clientWith(FAKE_API_KEY).searchRead('account.analytic.line', [], ['name']),
    ).rejects.toBeInstanceOf(OdooRpcError);
  });
});
