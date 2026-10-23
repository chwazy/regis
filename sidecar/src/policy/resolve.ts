export type Policy = 'auto' | 'ask' | 'deny';

export interface PolicyRule {
  agentId: string | null;
  toolPattern: string;
  policy: Policy;
}

export interface PolicyMatch {
  policy: Policy;
  matchedPattern: string | null;
}

export type DefaultWrite = 'ask' | 'deny';

export function parseDefaultWrite(raw: string | null | undefined): DefaultWrite {
  return raw === 'deny' ? 'deny' : 'ask';
}

const STRICTNESS: Record<Policy, number> = { deny: 2, ask: 1, auto: 0 };

export function matchPattern(pattern: string, qualifiedName: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$.+?()[\]{}|]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(qualifiedName);
}

function specificity(pattern: string): number {
  return pattern.replaceAll('*', '').length;
}

function strongestMatch(rules: PolicyRule[], qualifiedName: string): PolicyRule | undefined {
  let best: PolicyRule | undefined;
  for (const rule of rules) {
    if (!matchPattern(rule.toolPattern, qualifiedName)) {
      continue;
    }
    if (best === undefined) {
      best = rule;
      continue;
    }
    const gap = specificity(rule.toolPattern) - specificity(best.toolPattern);
    if (gap > 0 || (gap === 0 && STRICTNESS[rule.policy] > STRICTNESS[best.policy])) {
      best = rule;
    }
  }
  return best;
}

export function resolvePolicyMatch(
  rules: PolicyRule[],
  agentId: string,
  qualifiedName: string,
  access: 'read' | 'write',
  defaultWrite: DefaultWrite = 'ask',
): PolicyMatch {
  const matched =
    strongestMatch(
      rules.filter((rule) => rule.agentId === agentId),
      qualifiedName,
    ) ??
    strongestMatch(
      rules.filter((rule) => rule.agentId === null),
      qualifiedName,
    );
  if (matched) {
    return { policy: matched.policy, matchedPattern: matched.toolPattern };
  }
  return { policy: access === 'read' ? 'auto' : defaultWrite, matchedPattern: null };
}

export function resolvePolicy(
  rules: PolicyRule[],
  agentId: string,
  qualifiedName: string,
  access: 'read' | 'write',
  defaultWrite: DefaultWrite = 'ask',
): Policy {
  return resolvePolicyMatch(rules, agentId, qualifiedName, access, defaultWrite).policy;
}
