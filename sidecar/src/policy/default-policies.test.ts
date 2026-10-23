import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_PRESETS } from '../connectors/presets';
import { qualifyToolName } from '../mcp/host';
import { resolvePolicyMatch, type Policy, type PolicyRule } from './resolve';

function seededDefaults(): PolicyRule[] {
  const path = fileURLToPath(
    new URL('../../../apps/desktop/src-tauri/crates/regis-voice/src/seed.rs', import.meta.url),
  );
  const source = readFileSync(path, 'utf8');
  const block = /DEFAULT_TOOL_POLICIES[^=]*=\s*&\[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/\("([^"]+)",\s*Policy::(Auto|Ask|Deny)\)/g)].map((match) => ({
    agentId: null,
    toolPattern: match[1] ?? '',
    policy: (match[2] ?? '').toLowerCase() as Policy,
  }));
}

function defaultConnectorName(presetId: string): string {
  const preset = CONNECTOR_PRESETS[presetId];
  if (!preset) {
    throw new Error(`Unknown preset ${presetId}`);
  }
  return preset.build({}).name;
}

describe('seeded default tool policies', () => {
  const rules = seededDefaults();

  it('reads the seeded patterns', () => {
    expect(rules.length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ['the default Microsoft 365 send-mail tool', qualifyToolName(defaultConnectorName('m365'), 'send-mail')],
    [
      'the default Odoo timesheet creation tool',
      qualifyToolName(defaultConnectorName('odoo'), 'timesheet_create'),
    ],
    ['the seeded filesystem write tool', qualifyToolName('filesystem', 'write_file')],
  ])('asks for %s through a seeded pattern', (_label, qualifiedName) => {
    const match = resolvePolicyMatch(rules, 'any-agent', qualifiedName, 'write');

    expect(match.policy).toBe('ask');
    expect(match.matchedPattern).not.toBeNull();
  });

  it('keeps the write fallback to ask for unknown tools', () => {
    expect(resolvePolicyMatch(rules, 'any-agent', 'mcp__unknown__put', 'write').policy).toBe('ask');
  });
});
