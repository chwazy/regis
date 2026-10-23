import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-mcp', version: '0.0.0' });

const text = (value) => ({ content: [{ type: 'text', text: value }] });

server.registerTool(
  'echo_read',
  {
    description: 'Echo the given text',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ text: value }) => text(`echo:${value}`),
);
server.registerTool(
  'do_write',
  { description: 'Pretend to write something', inputSchema: { text: z.string() } },
  ({ text: value }) => text(`wrote:${value}`),
);
server.registerTool(
  'env_has',
  {
    description: 'Tell whether an environment variable is set',
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ name }) => text(String(process.env[name] !== undefined && process.env[name] !== '')),
);
server.registerTool(
  'get_pid',
  { description: 'Return the server process id', annotations: { readOnlyHint: true } },
  () => text(String(process.pid)),
);

if (process.env.ECHO_LEAK_VARIABLE) {
  console.error(`leaking ${process.env[process.env.ECHO_LEAK_VARIABLE]}`);
}
console.error('echo-mcp ready');

await server.connect(new StdioServerTransport());
