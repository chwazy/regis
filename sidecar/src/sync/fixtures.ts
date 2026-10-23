import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ToolFixture {
  _meta: { synthetic: boolean };
  value: unknown[];
}

export function readFixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`../../../tests/fixtures/mcp/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function toolText(body: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] };
}
