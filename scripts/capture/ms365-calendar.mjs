import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_OUT = 'tests/fixtures/mcp/ms365.events.captured.json';
const DEFAULT_DAYS = 14;
const MS_PER_DAY = 86_400_000;

// Doit rester identique à EVENT_FIELDS de sidecar/src/sync/m365.ts.
export const EVENT_FIELDS = [
  'id',
  'subject',
  'bodyPreview',
  'start',
  'end',
  'isAllDay',
  'isCancelled',
  'lastModifiedDateTime',
  'webLink',
  'location',
  'organizer',
  'attendees',
  'onlineMeeting',
  'onlineMeetingUrl',
  'isOnlineMeeting',
  'onlineMeetingProvider',
];

const USAGE = `Usage: ms365-calendar.mjs [--out <file>] [--days <n>] -- <command> [args...]

Capture une réponse réelle de get-calendar-view (select de Régis) via le serveur MCP
lancé par <command>, l'anonymise, puis l'écrit dans <file>
(défaut : ${DEFAULT_OUT}). Relire la sortie avant de la commiter.

Anonymisation : sujets, aperçus, lieux, adresses e-mail, noms, identifiants Graph et
liens web remplacés par des valeurs synthétiques ; le chemin du joinUrl devient
synthetic-<n> (l'hôte est conservé).

Options :
  --out <file>   fichier de sortie
  --days <n>     fenêtre à partir de maintenant (défaut ${DEFAULT_DAYS})
  --help         affiche cet usage`;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[A-Za-z]{2,})+/g;

function counter() {
  const seen = new Map();
  return (value, make) => {
    if (!seen.has(value)) {
      seen.set(value, make(seen.size + 1));
    }
    return seen.get(value);
  };
}

/** Anonymise une réponse get-calendar-view ({ value: [...] }) sans modifier l'entrée. */
export function anonymizeCalendar(input) {
  const subjects = counter();
  const emails = counter();
  const names = counter();
  const ids = counter();
  const urls = counter();
  const joins = counter();
  const places = counter();

  const url = (value, registry) => {
    let host;
    try {
      host = new URL(value).host;
    } catch {
      host = 'example.test';
    }
    return registry(value, (n) => `https://${host}/synthetic-${n}`);
  };
  const email = (value) => emails(value.toLowerCase(), (n) => `person${n}@example.test`);

  function walk(node, key) {
    if (Array.isArray(node)) {
      return node.map((entry) => walk(entry, key));
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, walk(child, name)]));
    }
    if (typeof node !== 'string' || node === '') {
      return node;
    }
    switch (key) {
      case 'id':
      case 'iCalUId':
      case 'seriesMasterId':
      case 'conversationId':
        return ids(node, (n) => `AAMkSYNTHETIC${String(n).padStart(4, '0')}`);
      case 'subject':
        return subjects(node, (n) => `Synthetic subject ${n}`);
      case 'bodyPreview':
        return 'Synthetic body preview.';
      case 'displayName':
        return places(node, (n) => `Synthetic place ${n}`);
      case 'name':
        return names(node, (n) => `Person ${n}`);
      case 'address':
        return email(node);
      case 'webLink':
        return url(node, urls);
      case 'joinUrl':
      case 'onlineMeetingUrl':
        return url(node, joins);
      default:
        return node.replaceAll(EMAIL, (match) => email(match));
    }
  }

  return walk(input, '');
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error(USAGE);
  }
  const options = { help: false, out: DEFAULT_OUT, days: DEFAULT_DAYS, command: argv.slice(separator + 1) };
  const flags = argv.slice(0, separator);
  for (let index = 0; index < flags.length; index += 2) {
    if (flags[index] === '--out') {
      options.out = flags[index + 1];
    } else if (flags[index] === '--days') {
      options.days = Number(flags[index + 1]);
    } else {
      throw new Error(`Unknown option ${flags[index]}\n${USAGE}`);
    }
  }
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error('--days must be a positive number');
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const client = createClient(options.command.join(' '));
  try {
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'regis-capture', version: '0.0.0' },
    });
    client.notify('notifications/initialized');
    const now = Date.now();
    const result = await client.request('tools/call', {
      name: 'get-calendar-view',
      arguments: {
        startDateTime: new Date(now).toISOString(),
        endDateTime: new Date(now + options.days * MS_PER_DAY).toISOString(),
        timezone: 'UTC',
        select: EVENT_FIELDS,
        top: 100,
      },
    });
    if (result.isError) {
      throw new Error(result.content?.map((block) => block.text).join('\n') ?? 'get-calendar-view failed');
    }
    const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
    const body = anonymizeCalendar(JSON.parse(text));
    const output = {
      _meta: {
        source: 'ms365',
        tool: 'get-calendar-view',
        synthetic: false,
        anonymized: true,
        capturedAt: new Date().toISOString(),
      },
      ...body,
    };
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(resolve(options.out), `${JSON.stringify(output, null, 2)}\n`);
    process.stderr.write(`${body.value?.length ?? 0} events -> ${options.out}\n`);
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
