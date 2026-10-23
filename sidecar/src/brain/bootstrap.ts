import { z } from 'zod';
import type { Entity, EntityKind, Fact, Item, LinkProposalRow } from '@regis/shared';
import { normalizeFactText, readEntityData, sourceKey, sourceKeyOf } from './entity-data';
import type { BrainStore } from './store';

export const ODOO_HOURS_FACT_PREFIX = 'Heures saisies sur Odoo : ';
const BOOTSTRAP_CONFIDENCE = 1;
const MINUTES_PER_HOUR = 60;

const reference = z.object({ id: z.number(), name: z.string() }).nullish();
const partnerData = z.looseObject({
  email: z.string().nullish(),
  phone: z.string().nullish(),
  isCompany: z.boolean().nullish(),
  parent: reference,
});
const projectData = z.looseObject({ partner: reference });
const timeEntryData = z.looseObject({ hours: z.number().nullish(), project: reference });

export interface BootstrapResult {
  clients: number;
  projects: number;
  contacts: number;
  links: number;
  hoursFacts: number;
}

interface PlannedEntity {
  sourceKind: 'partner' | 'project';
  item: Item;
  kind: EntityKind;
  extra: Record<string, unknown>;
}

type PartnerRole = 'client' | 'contact' | null;

export function formatHours(hours: number): string {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * MINUTES_PER_HOUR);
  if (minutes === 0) {
    return `${String(whole)} h`;
  }
  if (minutes === MINUTES_PER_HOUR) {
    return `${String(whole + 1)} h`;
  }
  return `${String(whole)} h ${String(minutes).padStart(2, '0')}`;
}

export function partnerRole(data: z.infer<typeof partnerData>, referencedByProject: boolean): PartnerRole {
  if (data.isCompany) {
    return 'client';
  }
  if (data.parent) {
    return 'contact';
  }
  return referencedByProject ? 'client' : null;
}

function parsePartner(item: Item): z.infer<typeof partnerData> {
  const parsed = partnerData.safeParse(item.dataJson);
  return parsed.success ? parsed.data : {};
}

function parseProject(item: Item): z.infer<typeof projectData> {
  const parsed = projectData.safeParse(item.dataJson);
  return parsed.success ? parsed.data : {};
}

function hoursByProject(timeEntries: Item[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of timeEntries) {
    const parsed = timeEntryData.safeParse(entry.dataJson);
    if (!parsed.success || !parsed.data.project) {
      continue;
    }
    const key = sourceKey(entry.connectorId, 'project', String(parsed.data.project.id));
    totals.set(key, (totals.get(key) ?? 0) + (parsed.data.hours ?? 0));
  }
  return totals;
}

export async function bootstrapFromOdoo(store: BrainStore): Promise<BootstrapResult> {
  const [partners, projects, timeEntries, existing] = await Promise.all([
    store.listItems('partner'),
    store.listItems('project'),
    store.listItems('time_entry'),
    store.listEntities(),
  ]);
  const result: BootstrapResult = { clients: 0, projects: 0, contacts: 0, links: 0, hoursFacts: 0 };
  const entitiesByKey = new Map<string, Entity>();
  for (const entity of existing) {
    const key = sourceKeyOf(entity);
    if (key) {
      entitiesByKey.set(key, entity);
    }
  }
  const referencedPartners = new Set<string>();
  for (const project of projects) {
    const partner = parseProject(project).partner;
    if (partner) {
      referencedPartners.add(sourceKey(project.connectorId, 'partner', String(partner.id)));
    }
  }

  const planned: PlannedEntity[] = [];
  const roles = new Map<string, PartnerRole>();
  for (const partner of partners) {
    const data = parsePartner(partner);
    const key = sourceKey(partner.connectorId, 'partner', partner.externalId);
    const role = partnerRole(data, referencedPartners.has(key));
    roles.set(key, role);
    if (role) {
      planned.push({
        sourceKind: 'partner',
        item: partner,
        kind: role,
        extra: { email: data.email ?? null, phone: data.phone ?? null },
      });
    }
  }
  for (const project of projects) {
    planned.push({ sourceKind: 'project', item: project, kind: 'project', extra: {} });
  }
  planned.sort((left, right) => entityOrder(left.kind) - entityOrder(right.kind));

  for (const plan of planned) {
    const key = sourceKey(plan.item.connectorId, plan.sourceKind, plan.item.externalId);
    const known = entitiesByKey.get(key);
    const dataJson = {
      connectorId: plan.item.connectorId,
      sourceKind: plan.sourceKind,
      externalId: plan.item.externalId,
      ...plan.extra,
    };
    if (known && isUpToDate(known, plan.item.title, dataJson)) {
      continue;
    }
    const saved = await store.saveEntity({
      ...(known ? { id: known.id } : {}),
      kind: known?.kind ?? plan.kind,
      name: plan.item.title,
      tagsJson: known?.tagsJson ?? [],
      dataJson,
    });
    entitiesByKey.set(key, saved);
    if (!known) {
      result[plan.kind === 'project' ? 'projects' : plan.kind === 'client' ? 'clients' : 'contacts'] += 1;
    }
  }

  const clientOfPartner = (connectorId: string, partnerId: number): Entity | undefined => {
    const key = sourceKey(connectorId, 'partner', String(partnerId));
    const entity = entitiesByKey.get(key);
    if (entity?.kind === 'client') {
      return entity;
    }
    const contactItem = partners.find(
      (partner) => sourceKey(partner.connectorId, 'partner', partner.externalId) === key,
    );
    const parent = contactItem ? parsePartner(contactItem).parent : null;
    if (!parent) {
      return undefined;
    }
    const parentEntity = entitiesByKey.get(sourceKey(connectorId, 'partner', String(parent.id)));
    return parentEntity?.kind === 'client' ? parentEntity : undefined;
  };

  const rows: LinkProposalRow[] = [];
  const addLink = (from: Entity | undefined, to: Entity | undefined): void => {
    if (from && to) {
      rows.push({
        fromType: 'entity',
        fromId: from.id,
        toEntityId: to.id,
        rel: 'belongs_to',
        confidence: BOOTSTRAP_CONFIDENCE,
      });
    }
  };
  for (const partner of partners) {
    if (roles.get(sourceKey(partner.connectorId, 'partner', partner.externalId)) !== 'contact') {
      continue;
    }
    const parent = parsePartner(partner).parent;
    addLink(
      entitiesByKey.get(sourceKey(partner.connectorId, 'partner', partner.externalId)),
      parent ? clientOfPartner(partner.connectorId, parent.id) : undefined,
    );
  }
  for (const project of projects) {
    const partner = parseProject(project).partner;
    addLink(
      entitiesByKey.get(sourceKey(project.connectorId, 'project', project.externalId)),
      partner ? clientOfPartner(project.connectorId, partner.id) : undefined,
    );
  }
  result.links = await store.insertAutoLinks(rows);

  result.hoursFacts = await syncHoursFacts(store, projects, entitiesByKey, hoursByProject(timeEntries));
  return result;
}

function isUpToDate(entity: Entity, name: string, dataJson: Record<string, unknown>): boolean {
  const current = readEntityData(entity);
  return (
    entity.name === name &&
    (current.email ?? null) === (dataJson.email ?? null) &&
    (current.phone ?? null) === (dataJson.phone ?? null)
  );
}

function entityOrder(kind: EntityKind): number {
  return kind === 'client' ? 0 : kind === 'contact' ? 1 : 2;
}

async function syncHoursFacts(
  store: BrainStore,
  projects: Item[],
  entitiesByKey: Map<string, Entity>,
  totals: Map<string, number>,
): Promise<number> {
  let written = 0;
  for (const project of projects) {
    const key = sourceKey(project.connectorId, 'project', project.externalId);
    const entity = entitiesByKey.get(key);
    const hours = totals.get(key) ?? 0;
    if (!entity || hours <= 0) {
      continue;
    }
    const text = `${ODOO_HOURS_FACT_PREFIX}${formatHours(hours)}`;
    const facts = await store.listFacts(entity.id);
    const stale = facts.filter(isHoursFactOf(project.id));
    const current = stale.find((fact) => normalizeFactText(fact.text) === normalizeFactText(text));
    for (const fact of stale) {
      if (fact !== current) {
        await store.deleteFact(fact.id);
      }
    }
    if (!current) {
      await store.addFact({
        entityId: entity.id,
        text,
        sourceType: 'item',
        sourceId: project.id,
        status: 'confirmed',
      });
      written += 1;
    }
  }
  return written;
}

function isHoursFactOf(projectItemId: string): (fact: Fact) => boolean {
  return (fact) =>
    fact.sourceType === 'item' &&
    fact.sourceId === projectItemId &&
    fact.text.startsWith(ODOO_HOURS_FACT_PREFIX);
}
