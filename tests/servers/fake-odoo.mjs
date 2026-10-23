import { createServer } from 'node:http';

export const FAKE_UID = 7;
export const FAKE_API_KEY = 'fake-odoo-key';
export const FAKE_DB = 'fake-db';
export const FAKE_LOGIN = 'user@example.test';

const PAST_DUE = '2020-01-31';

export const FAKE_DATA = {
  'res.partner': [
    {
      id: 11,
      name: 'Acme SA',
      email: 'info@acme.test',
      phone: false,
      is_company: true,
      parent_id: false,
      write_date: '2026-10-01 08:00:00',
    },
    {
      id: 12,
      name: 'Jane Doe',
      email: 'jane@acme.test',
      phone: '+41 21 000 00 00',
      is_company: false,
      parent_id: [11, 'Acme SA'],
      write_date: '2026-10-02 09:30:00',
    },
  ],
  'project.project': [
    {
      id: 3,
      name: 'Refonte site',
      partner_id: [11, 'Acme SA'],
      user_id: [7, 'Fake User'],
      date_start: '2026-09-01',
      date: false,
      description: false,
      write_date: '2026-10-03 10:00:00',
    },
  ],
  'project.task': [
    {
      id: 21,
      name: 'Maquettes',
      project_id: [3, 'Refonte site'],
      stage_id: [1, 'En cours'],
      partner_id: [11, 'Acme SA'],
      date_deadline: '2026-11-01 12:00:00',
      priority: '0',
      state: '01_in_progress',
      description: '<p>Préparer les maquettes</p>',
      write_date: '2026-10-04 11:00:00',
    },
  ],
  'account.analytic.line': [
    {
      id: 31,
      date: '2026-10-20',
      name: 'Atelier',
      unit_amount: 1.5,
      project_id: [3, 'Refonte site'],
      task_id: [21, 'Maquettes'],
      write_date: '2026-10-20 17:00:00',
    },
  ],
  'account.move': [
    {
      id: 41,
      name: 'INV/2026/0001',
      partner_id: [11, 'Acme SA'],
      invoice_date: '2026-08-01',
      invoice_date_due: PAST_DUE,
      amount_total: 1200.5,
      currency_id: [5, 'CHF'],
      payment_state: 'not_paid',
      state: 'posted',
      write_date: '2026-08-01 09:00:00',
    },
  ],
};

function reply(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }));
}

function rpcError(message) {
  return { error: { code: 200, message: 'Odoo Server Error', data: { message } } };
}

function handleObject(args, journal, options, response) {
  const [db, uid, apiKey, model, method, callArgs, kwargs] = args;
  if (db !== FAKE_DB || uid !== FAKE_UID || apiKey !== FAKE_API_KEY) {
    reply(response, rpcError('Access Denied'));
    return;
  }
  journal.push({
    service: 'object',
    method: 'execute_kw',
    model,
    odooMethod: method,
    args: callArgs,
    kwargs,
  });
  if (options.missingModels.includes(model)) {
    reply(response, rpcError(`Object ${model} doesn't exist`));
    return;
  }
  const rows = FAKE_DATA[model] ?? [];
  if (method === 'search_read') {
    const limit = kwargs?.limit;
    reply(response, { result: typeof limit === 'number' ? rows.slice(0, limit) : rows });
  } else if (method === 'read') {
    const ids = callArgs[0];
    reply(response, { result: rows.filter((row) => ids.includes(row.id)) });
  } else if (method === 'create') {
    reply(response, { result: 901 });
  } else if (method === 'write') {
    reply(response, { result: true });
  } else {
    reply(response, rpcError(`Unsupported method ${method}`));
  }
}

export async function startFakeOdoo(options = {}) {
  const settings = { missingModels: options.missingModels ?? [] };
  const journal = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url !== '/jsonrpc' || request.method !== 'POST') {
        response.writeHead(404);
        response.end();
        return;
      }
      const { params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (params.service === 'common' && params.method === 'authenticate') {
        const [db, login, apiKey] = params.args;
        journal.push({ service: 'common', method: 'authenticate', login });
        const valid = db === FAKE_DB && login === FAKE_LOGIN && apiKey === FAKE_API_KEY;
        reply(response, { result: valid ? FAKE_UID : false });
        return;
      }
      if (params.service === 'object' && params.method === 'execute_kw') {
        handleObject(params.args, journal, settings, response);
        return;
      }
      reply(response, rpcError('Unknown service'));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    journal,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
