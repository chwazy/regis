import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';

const APPROVE_TOOL = {
  name: 'approve',
  description: 'Decides whether Claude Code may run a tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object', additionalProperties: true },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

function parseArgs(argv) {
  const options = { port: 0, behavior: 'allow', record: null, fixture: null };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (key && key in options) {
      options[key] = argv[index + 1];
    }
  }
  options.port = Number(options.port);
  return options;
}

function renameLastSegment(filePath, newName) {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf(String.fromCharCode(92)));
  return `${filePath.slice(0, separatorIndex + 1)}${newName}`;
}

export function buildResponse(options, request) {
  if (
    options.renameTo &&
    options.behavior === 'allow' &&
    request?.tool_name?.endsWith('__write_file') &&
    typeof request?.input?.path === 'string'
  ) {
    return {
      behavior: 'allow',
      updatedInput: { ...request.input, path: renameLastSegment(request.input.path, options.renameTo) },
    };
  }
  if (options.fixture) {
    const fixture = JSON.parse(readFileSync(options.fixture, 'utf8'));
    return options.behavior === 'allow' ? fixture.allowResponse : fixture.denyResponse;
  }
  if (options.behavior === 'allow') {
    return { behavior: 'allow' };
  }
  return { behavior: 'deny', message: 'Denied by the regis-test permission server.' };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function handleMessage(message, options, received) {
  switch (message.method) {
    case 'initialize':
      return rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'regis-test', version: '0.0.0' },
      });
    case 'tools/list':
      return rpcResult(message.id, { tools: [APPROVE_TOOL] });
    case 'tools/call': {
      const request = message.params?.arguments ?? {};
      received.push(request);
      if (options.record) {
        writeFileSync(options.record, `${JSON.stringify(received, null, 2)}\n`);
      }
      const response = buildResponse(options, request);
      return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(response) }] });
    }
    case 'ping':
      return rpcResult(message.id, {});
    default:
      if (message.id === undefined) {
        return null;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function startPermissionServer(options) {
  const received = [];
  const authorizations = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (options.expectedAuthorization) {
      const matches = request.headers.authorization === options.expectedAuthorization;
      authorizations.push(matches);
      if (!matches) {
        response.writeHead(401).end();
        return;
      }
    }
    const message = JSON.parse(await readBody(request));
    const reply = Array.isArray(message)
      ? message.map((item) => handleMessage(item, options, received)).filter(Boolean)
      : handleMessage(message, options, received);
    if (!reply || (Array.isArray(reply) && reply.length === 0)) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  return new Promise((resolve) => {
    server.listen(options.port, '127.0.0.1', () => resolve({ server, received, authorizations }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2));
  const { server } = await startPermissionServer(options);
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({ port: address.port, url: `http://127.0.0.1:${address.port}/mcp` })}\n`,
  );
}
