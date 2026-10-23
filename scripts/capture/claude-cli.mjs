import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { buildResponse, startPermissionServer } from './permission-server.mjs';

const BACKSLASH = String.fromCharCode(92);
const SINGLE_SEPARATOR = new RegExp(`${BACKSLASH}${BACKSLASH}(?![nrtbfu"/])`, 'g');
const PERMISSION_TOOL = 'mcp__regis-test__approve';

function parseArgs(argv) {
  const options = {
    prompt: null,
    out: null,
    model: null,
    mcpConfig: null,
    allowedTools: null,
    permissionBehavior: null,
    recordRequest: null,
    permissionFixture: null,
    cwd: null,
    renameTo: null,
    checkHeaderExpansion: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) {
      throw new Error(`Unknown option ${argv[index]}`);
    }
    options[key] = argv[index + 1];
  }
  if (!options.prompt || !options.out) {
    throw new Error('--prompt and --out are required');
  }
  return options;
}

function readVersion() {
  return new Promise((resolveVersion, reject) => {
    const child = spawn('claude --version', { shell: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', () => resolveVersion(output.trim()));
  });
}

function toSlug(directory) {
  return directory.replaceAll(/[^A-Za-z0-9]/g, '-');
}

function listUserAgentNames() {
  const agentsDirectory = join(homedir(), '.claude', 'agents');
  if (!existsSync(agentsDirectory)) {
    return new Set();
  }
  return new Set(
    readdirSync(agentsDirectory)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3)),
  );
}

function shortNameSegments(directories) {
  return directories.flatMap((directory) =>
    directory.split(/[\\/]/).filter((segment) => segment.includes('~')),
  );
}

function buildScrubber(workingDirectory) {
  const directories = [
    [workingDirectory, '<WORKSPACE>'],
    [realpathSync.native(workingDirectory), '<WORKSPACE>'],
    [tmpdir(), '<TMP>'],
    [realpathSync.native(tmpdir()), '<TMP>'],
    [homedir(), '<HOME>'],
  ];
  const slugs = directories.map(([directory, placeholder]) => [
    toSlug(directory),
    `<${placeholder.slice(1, -1)}-SLUG>`,
  ]);
  const literals = [
    ...slugs,
    ...directories.flatMap(([directory, placeholder]) => [
      [directory, placeholder],
      [directory.replaceAll(BACKSLASH, '/'), placeholder],
      [directory.replaceAll(BACKSLASH, BACKSLASH + BACKSLASH), placeholder],
      [directory.replaceAll(BACKSLASH, BACKSLASH.repeat(4)), placeholder],
    ]),
    [userInfo().username, '<USER>'],
    ...shortNameSegments([tmpdir(), homedir()]).map((segment) => [segment, '<USER>']),
  ].sort((left, right) => right[0].length - left[0].length);
  const placeholders = new Set(directories.map(([, placeholder]) => placeholder));
  const userAgentNames = listUserAgentNames();

  const scrubString = (value) => {
    let scrubbed = value;
    for (const [literal, placeholder] of literals) {
      scrubbed = scrubbed.replaceAll(literal, placeholder);
    }
    for (const placeholder of placeholders) {
      if (scrubbed.includes(placeholder)) {
        for (const length of [4, 2]) {
          scrubbed = scrubbed.replaceAll(BACKSLASH.repeat(length), '/');
        }
        scrubbed = scrubbed.replaceAll(SINGLE_SEPARATOR, '/');
        break;
      }
    }
    return scrubbed.replaceAll(/[\w.+-]+@[\w-]+(?:\.[A-Za-z]{2,})+/g, 'user@example.test');
  };

  const scrubValue = (value, key) => {
    if (typeof value === 'string') {
      return scrubString(value);
    }
    if (Array.isArray(value)) {
      const items = key === 'agents' ? value.filter((item) => !userAgentNames.has(item)) : value;
      return items.map((item) => scrubValue(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [scrubString(name), scrubValue(item, name)]),
      );
    }
    return value;
  };

  return { scrubString, scrubLine: (line) => JSON.stringify(scrubValue(JSON.parse(line))) };
}

function runClaude(args, workingDirectory, extraEnv) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('claude', args, {
      cwd: workingDirectory,
      shell: false,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

const options = parseArgs(process.argv.slice(2));
const workingDirectory = resolve(options.cwd ?? mkdtempSync(join(tmpdir(), 'regis-capture-')));
mkdirSync(workingDirectory, { recursive: true });

const ISOLATION_FLAGS = [
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
];
const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose', ...ISOLATION_FLAGS];
const commandParts = [
  'claude',
  '-p',
  JSON.stringify(options.prompt),
  '--output-format',
  'stream-json',
  '--verbose',
  ...ISOLATION_FLAGS,
];
if (options.model) {
  args.push('--model', options.model);
  commandParts.push('--model', options.model);
}
if (options.allowedTools) {
  args.push('--allowedTools', options.allowedTools);
  commandParts.push('--allowedTools', options.allowedTools);
}

const HEADER_SECRET_ENV = 'REGIS_MCP_SECRET_REGIS_TEST';
const bearerToken = options.checkHeaderExpansion ? randomBytes(24).toString('hex') : null;
let permissionServer = null;
let mcpConfigPath = options.mcpConfig ? resolve(options.mcpConfig) : null;
if (options.permissionBehavior) {
  permissionServer = await startPermissionServer({
    port: 0,
    behavior: options.permissionBehavior,
    renameTo: options.renameTo,
    expectedAuthorization: bearerToken ? `Bearer ${bearerToken}` : null,
    record: null,
    fixture: options.permissionFixture ? resolve(options.permissionFixture) : null,
  });
  const { port } = permissionServer.server.address();
  const baseConfig = mcpConfigPath ? JSON.parse(readFileSync(mcpConfigPath, 'utf8')) : {};
  const mergedConfig = {
    mcpServers: {
      ...baseConfig.mcpServers,
      'regis-test': {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        ...(bearerToken ? { headers: { Authorization: `Bearer \${${HEADER_SECRET_ENV}}` } } : {}),
      },
    },
  };
  mcpConfigPath = join(workingDirectory, '.capture-mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mergedConfig));
  args.push('--permission-prompt-tool', PERMISSION_TOOL);
  commandParts.push('--permission-prompt-tool', PERMISSION_TOOL);
}
if (mcpConfigPath) {
  args.push('--mcp-config', mcpConfigPath);
  commandParts.push('--mcp-config', '<mcp-config.json>');
}

const toolVersion = await readVersion();
const run = await runClaude(args, workingDirectory, bearerToken ? { [HEADER_SECRET_ENV]: bearerToken } : {});
permissionServer?.server.close();

const { scrubString, scrubLine } = buildScrubber(workingDirectory);
const meta = {
  _meta: {
    source: 'claude-cli',
    toolVersion,
    capturedAt: new Date().toISOString(),
    command: scrubString(commandParts.join(' ')),
    synthetic: false,
  },
};
const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
for (const line of lines) {
  JSON.parse(line);
}
mkdirSync(resolve(options.out, '..'), { recursive: true });
writeFileSync(resolve(options.out), `${[JSON.stringify(meta), ...lines.map(scrubLine)].join('\n')}\n`);

if (permissionServer && options.recordRequest) {
  const lastRequest = permissionServer.received.at(-1) ?? {};
  const promptFixture = {
    _meta: { ...meta._meta, command: meta._meta.command },
    request: JSON.parse(scrubLine(JSON.stringify(lastRequest))),
    allowResponse: buildResponse({ behavior: 'allow', fixture: null }),
    denyResponse: buildResponse({ behavior: 'deny', fixture: null }),
    allRequestsSeen: permissionServer.received.map((request) =>
      JSON.parse(scrubLine(JSON.stringify(request))),
    ),
  };
  writeFileSync(
    resolve(options.recordRequest),
    `${JSON.stringify(promptFixture, null, 2)}
`,
  );
}
if (permissionServer && bearerToken) {
  const { authorizations } = permissionServer;
  process.stderr.write(
    `header expansion: ${authorizations.filter(Boolean).length} request(s) with the expected bearer, ${authorizations.filter((matched) => !matched).length} rejected (401)
`,
  );
}
process.stderr.write(
  `claude exit=${run.code}, ${lines.length} events -> ${options.out}\n${scrubString(run.stderr)}`,
);
