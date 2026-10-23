import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerHookTools, type HookTools } from './hook-tools';
import { registerBrainTools, type BrainTools } from './brain-tools';
import { registerJobsTools, type JobsTools } from './jobs-tools';
import { registerTemplateTools, type TemplateTools } from './template-tools';
import { approveInputShape, permissionResult, type ApproveContext, type PermissionResponse } from './approve';

export const REGIS_JOB_HEADER = 'x-regis-job-id';
export const REGIS_AGENT_HEADER = 'x-regis-agent-id';
export const REGIS_MCP_PATH = '/mcp';
const LOOPBACK = '127.0.0.1';

export interface RegisMcpEndpoint {
  url: string;
  token: string;
}

export interface RegisMcpServerOptions {
  approve: (context: ApproveContext, args: unknown) => Promise<PermissionResponse>;
  onLog: (line: string) => void;
  jobs?: JobsTools;
  hooks?: HookTools;
  brain?: BrainTools;
  templates?: TemplateTools;
  token?: string;
}

export class RegisMcpServer {
  private readonly token: string;
  private server: Server | undefined;
  private starting: Promise<RegisMcpEndpoint> | undefined;

  constructor(private readonly options: RegisMcpServerOptions) {
    this.token = options.token ?? randomBytes(32).toString('hex');
  }

  start(): Promise<RegisMcpEndpoint> {
    this.starting ??= this.listen();
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
  }

  private listen(): Promise<RegisMcpEndpoint> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.onLog(`[regis-mcp] requête en échec : ${String(error)}`);
        if (!response.headersSent) {
          response.writeHead(500).end();
        }
      });
    });
    this.server = server;
    return new Promise<RegisMcpEndpoint>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, LOOPBACK, () => {
        const { port } = server.address() as AddressInfo;
        resolveListen({ url: `http://${LOOPBACK}:${String(port)}${REGIS_MCP_PATH}`, token: this.token });
      });
    });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const received = Buffer.from(request.headers.authorization ?? '');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.isAuthorized(request)) {
      response.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized');
      return;
    }
    if (new URL(request.url ?? '/', `http://${LOOPBACK}`).pathname !== REGIS_MCP_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const context: ApproveContext = {
      jobId: headerValue(request, REGIS_JOB_HEADER),
      agentId: headerValue(request, REGIS_AGENT_HEADER),
    };
    const mcp = new McpServer({ name: 'regis', version: '0.1.0' });
    mcp.registerTool(
      'approve',
      {
        description: 'Decides whether Claude Code may run a tool call.',
        inputSchema: approveInputShape,
      },
      async (args) => permissionResult(await this.options.approve(context, args)),
    );
    if (this.options.jobs) {
      registerJobsTools(mcp, context, this.options.jobs);
    }
    if (this.options.hooks) {
      registerHookTools(mcp, this.options.hooks);
    }
    if (this.options.brain) {
      registerBrainTools(mcp, context, this.options.brain);
    }
    if (this.options.templates) {
      registerTemplateTools(mcp, context, this.options.templates);
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  }
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}
