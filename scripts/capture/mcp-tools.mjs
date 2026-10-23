import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error(
      'Usage: mcp-tools.mjs --out <file> [--placeholder <path>=<name>]... -- <command> [args...]',
    );
  }
  const options = { out: null, placeholders: [], command: argv.slice(separator + 1) };
  const flags = argv.slice(0, separator);
  for (let index = 0; index < flags.length; index += 2) {
    if (flags[index] === '--out') {
      options.out = flags[index + 1];
    } else if (flags[index] === '--placeholder') {
      const [value, name] = flags[index + 1].split('=');
      options.placeholders.push([value, name]);
    } else {
      throw new Error(`Unknown option ${flags[index]}`);
    }
  }
  if (!options.out) {
    throw new Error('--out is required');
  }
  return options;
}

function createClient(commandLine) {
  const child = spawn(commandLine, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      }
    }
  });
  child.stderr.on('data', () => {});

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) =>
    new Promise((resolveRequest, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`Timeout on ${method}`)), REQUEST_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
        } else {
          resolveRequest(message.result);
        }
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  return { request, notify, close: () => child.kill() };
}

function scrub(text, placeholders) {
  let scrubbed = text;
  for (const [value, name] of placeholders) {
    scrubbed = scrubbed.replaceAll(value, name);
  }
  return scrubbed.replaceAll(/[\w.+-]+@[\w-]+(?:\.[A-Za-z]{2,})+/g, 'user@example.test');
}

const options = parseArgs(process.argv.slice(2));
const client = createClient(options.command.join(' '));
try {
  const initialized = await client.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'regis-capture', version: '0.0.0' },
  });
  client.notify('notifications/initialized');
  const tools = [];
  let cursor;
  do {
    const page = await client.request('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const output = {
    _meta: {
      source: 'mcp',
      toolVersion: `${initialized.serverInfo.name}@${initialized.serverInfo.version}`,
      capturedAt: new Date().toISOString(),
      command: scrub(options.command.join(' '), options.placeholders),
      synthetic: false,
    },
    protocolVersion: initialized.protocolVersion,
    serverInfo: initialized.serverInfo,
    tools,
  };
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(resolve(options.out), `${scrub(JSON.stringify(output, null, 2), options.placeholders)}\n`);
  process.stderr.write(`${tools.length} tools -> ${options.out}\n`);
} finally {
  client.close();
}
