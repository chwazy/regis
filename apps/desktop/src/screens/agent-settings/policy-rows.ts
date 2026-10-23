import type { Policy, ToolPolicy } from '@regis/shared';

export type PolicyScope = { kind: 'default' } | { kind: 'agent'; agentId: string };

export interface PolicyRow {
  pattern: string;
  policy: Policy;
  inherited: boolean;
}

export const POLICY_OPTIONS: { value: Policy; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'ask', label: 'Demander' },
  { value: 'deny', label: 'Interdit' },
];

export function buildPolicyRows(policies: ToolPolicy[], scope: PolicyScope): PolicyRow[] {
  const defaults = new Map<string, Policy>();
  const overrides = new Map<string, Policy>();
  for (const entry of policies) {
    if (entry.agentId === null) {
      defaults.set(entry.toolPattern, entry.policy);
    } else if (scope.kind === 'agent' && entry.agentId === scope.agentId) {
      overrides.set(entry.toolPattern, entry.policy);
    }
  }
  const patterns = [...new Set([...defaults.keys(), ...overrides.keys()])].sort();
  return patterns.flatMap((pattern) => {
    const override = overrides.get(pattern);
    const policy = override ?? defaults.get(pattern);
    return policy === undefined ? [] : [{ pattern, policy, inherited: override === undefined }];
  });
}

export function policyToSave(scope: PolicyScope, pattern: string, policy: Policy): ToolPolicy {
  return {
    id: '',
    agentId: scope.kind === 'agent' ? scope.agentId : null,
    toolPattern: pattern.trim(),
    policy,
  };
}
