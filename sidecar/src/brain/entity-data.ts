import { z } from 'zod';
import type { Entity } from '@regis/shared';

export const CONTACT_CLIENT_IDS_KEY = 'clientEntityIds';

const entityData = z.looseObject({
  connectorId: z.string().optional(),
  sourceKind: z.enum(['partner', 'project']).optional(),
  externalId: z.string().optional(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  clientEntityIds: z.array(z.string()).optional(),
});

export type EntityData = z.infer<typeof entityData>;

export function readEntityData(entity: Entity): EntityData {
  const parsed = entityData.safeParse(entity.dataJson);
  return parsed.success ? parsed.data : {};
}

export function sourceKeyOf(entity: Entity): string | null {
  const { connectorId, sourceKind, externalId } = readEntityData(entity);
  return connectorId && sourceKind && externalId ? sourceKey(connectorId, sourceKind, externalId) : null;
}

export function sourceKey(connectorId: string, sourceKind: string, externalId: string): string {
  return `${connectorId}:${sourceKind}:${externalId}`;
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeFactText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  return needle !== '' && ` ${normalizeText(haystack)} `.includes(` ${needle} `);
}

export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : null;
}
