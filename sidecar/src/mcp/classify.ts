import type { ToolAccess } from '@regis/shared';

const READ_SEGMENTS = new Set(['get', 'list', 'search', 'read', 'find', 'query', 'aggregate']);

function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0);
}

export function classifyTool(
  tool: { name: string; annotations?: { readOnlyHint?: boolean } },
  override?: ToolAccess,
): ToolAccess {
  if (override) {
    return override;
  }
  if (tool.annotations?.readOnlyHint !== undefined) {
    return tool.annotations.readOnlyHint ? 'read' : 'write';
  }
  const segments = nameSegments(tool.name);
  const first = segments[0];
  return first !== undefined && READ_SEGMENTS.has(first) ? 'read' : 'write';
}
