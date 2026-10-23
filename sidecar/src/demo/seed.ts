import type { Agent, Connector, ItemUpsert, Job, JobEvent, NewJob, NewJobEvent } from '@regis/shared';
import { synthesisSignature, synthesisSourceCount, type SynthesisStore } from '../brain/synthesis';
import { buildDemoItems, type DemoSourceIds } from './dataset';

export const DEMO_ENV = 'REGIS_DEMO';
const FAKE_CLAUDE_ENV_PREFIX = 'FAKE_CLAUDE_';
const MS_PER_MINUTE = 60_000;

export function isDemoMode(env: NodeJS.ProcessEnv): boolean {
  return env[DEMO_ENV] === '1';
}

export function demoAgentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith(FAKE_CLAUDE_ENV_PREFIX) && entry[1] !== undefined,
    ),
  );
}

export interface DemoSeedDeps {
  listConnectors: () => Promise<Connector[]>;
  listAgents: () => Promise<Agent[]>;
  listJobs: () => Promise<Job[]>;
  upsertItems: (items: ItemUpsert[]) => Promise<number>;
  bootstrapBrain: () => Promise<unknown>;
  syntheses: Pick<SynthesisStore, 'listEntities' | 'entityCard' | 'listSyntheses' | 'saveSynthesis'>;
  createJob: (job: NewJob) => Promise<Job>;
  appendEvent: (event: NewJobEvent) => Promise<JobEvent>;
  updateJob: (id: string, patch: Record<string, unknown>) => Promise<Job>;
  requestApproval: (jobId: string, tool: string, input: unknown) => Promise<unknown>;
  now: () => Date;
  onLog: (line: string) => void;
  timeZone: string;
}

export interface DemoSeedResult {
  items: number;
  syntheses: number;
  jobs: number;
  approvals: number;
}

function sourceIds(connectors: Connector[]): DemoSourceIds {
  const idOf = (kind: string): string => {
    const connector = connectors.find((candidate) => candidate.kind === kind);
    if (!connector) {
      throw new Error(`Connecteur de démo ${kind} absent`);
    }
    return connector.id;
  };
  return { m365: idOf('m365'), odoo: idOf('odoo') };
}

function minutesAgo(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * MS_PER_MINUTE).toISOString();
}

function demoJob(
  agentId: string,
  fields: Partial<NewJob> & Pick<NewJob, 'title' | 'prompt' | 'status'>,
): NewJob {
  return {
    parentId: null,
    agentId,
    kind: 'task',
    sessionId: null,
    cwd: null,
    routingReason: 'Données de démonstration',
    resultText: null,
    error: null,
    startedAt: null,
    endedAt: null,
    ...fields,
  };
}

interface DemoApproval {
  title: string;
  prompt: string;
  minutesAgo: number;
  tool: string;
  input: unknown;
}

interface DemoMail {
  subject: string;
  content: string;
  to: string[];
  cc?: string[];
  attachments?: string[];
}

function mailInput(mail: DemoMail): unknown {
  const recipients = (addresses: string[]) => addresses.map((address) => ({ emailAddress: { address } }));
  return {
    body: {
      Message: {
        subject: mail.subject,
        body: { contentType: 'Text', content: mail.content },
        toRecipients: recipients(mail.to),
        ...(mail.cc ? { ccRecipients: recipients(mail.cc) } : {}),
        ...(mail.attachments ? { attachments: mail.attachments.map((name) => ({ name })) } : {}),
      },
    },
  };
}

const LONG_OFFER_MAIL = [
  'Bonjour Madame Rochat,',
  'Suite à notre visite du 14 octobre et à l’échange avec votre responsable de production, je vous transmets notre proposition pour l’extension du contrôle vision au poste 3 de la ligne de conditionnement.',
  'Périmètre proposé :',
  '1. Fourniture et montage d’une caméra matricielle 5 MP avec éclairage annulaire, supports inox et capot de protection IP65.',
  '2. Intégration dans l’automate existant : nouveau bloc fonctionnel de tri, échange des résultats via OPC UA et ajout de deux alarmes sur le pupitre opérateur.',
  '3. Apprentissage des références actuelles (12 formats), réglage des tolérances avec votre équipe qualité et rédaction du mode opératoire de changement de format.',
  '4. Mise en service sur site en deux interventions de nuit pour ne pas arrêter la production, puis une semaine de suivi à distance.',
  'Planning indicatif : commande de la caméra dès validation, livraison sous 4 à 5 semaines, mise en service la semaine suivante. Nous pouvons nous caler sur votre arrêt technique de fin novembre si cela vous arrange.',
  'Points à confirmer de votre côté :',
  '- la disponibilité d’une alimentation 24 V et d’un port réseau libre sur l’armoire du poste 3 ;',
  '- le nom de la personne qui validera les tolérances lors de la réception ;',
  '- le format de rapport souhaité pour le suivi des rejets (CSV journalier ou tableau de bord).',
  'L’offre détaillée, le schéma d’implantation et la fiche technique de la caméra sont joints. Le chiffrage reste valable 60 jours.',
  'Je reste à disposition pour en discuter, par téléphone ou lors d’une courte visio cette semaine.',
  'Meilleures salutations,\nDylan',
].join('\n\n');

const COMMISSIONING_REPORT = [
  '# Rapport de mise en service — ligne 3',
  '',
  '## Contexte',
  'Mise en service du convoyeur aval et de la nouvelle passerelle OPC UA chez Romandie Automation.',
  '',
  '## Essais réalisés',
  ...Array.from(
    { length: 18 },
    (_, index) =>
      `- Essai ${String(index + 1)} : séquence ${String((index % 6) + 1)} validée, temps de cycle conforme.`,
  ),
  '',
  '## Réserves',
  '- Capteur de présence B12 à réaligner (intervention planifiée).',
  '- Documentation des alarmes à compléter avant la réception finale.',
  '',
  '## Conclusion',
  'La ligne est apte à produire. Réception finale proposée après levée des deux réserves.',
].join('\n');

const DEMO_SYNTHESES: Record<string, string> = {
  'Romandie Automation SA':
    'Intégrateur partenaire historique, interlocuteur principal Marc Dufour. Le sujet du moment est la migration SCADA de la ligne 3 : la mise en service est imminente et Marc attend une date ferme. Deux réserves restent à lever avant la réception finale, dont le réalignement d’un capteur de présence. Prochaine étape : confirmer la mise en service et livrer le rapport.',
  'Fromagerie du Jorat':
    'Client de maintenance pour la supervision des caves. Une alarme récurrente sur la cave 2 est en cours d’analyse et une visite sur site est prévue. La facturation demande un suivi : une facture est échue. Prochaine étape : diagnostiquer l’alarme lors de la visite puis relancer le paiement.',
  'Léman Packaging Sàrl':
    'Client industriel de l’emballage, contact principal Claire Rochat. Le contrôle vision de la ligne de conditionnement fonctionne, et une extension au poste 3 est en discussion. L’offre détaillée est prête mais n’est pas encore envoyée. Prochaine étape : envoyer l’offre et caler la mise en service sur l’arrêt technique de fin novembre.',
};

async function seedDemoSyntheses(store: DemoSeedDeps['syntheses']): Promise<number> {
  const existing = new Set((await store.listSyntheses()).map((synthesis) => synthesis.entityId));
  let saved = 0;
  for (const entity of await store.listEntities()) {
    const text = DEMO_SYNTHESES[entity.name];
    if (text === undefined || existing.has(entity.id)) {
      continue;
    }
    const card = await store.entityCard(entity.id);
    await store.saveSynthesis({
      entityId: entity.id,
      text,
      sourceCount: synthesisSourceCount(card),
      signature: synthesisSignature(card),
      jobId: null,
    });
    saved += 1;
  }
  return saved;
}

function demoApprovals(now: Date): DemoApproval[] {
  const today = now.toISOString().slice(0, 10);
  return [
    {
      title: 'Saisir les heures du jour',
      prompt: 'Saisis mes heures du jour sur Odoo à partir de mon agenda.',
      minutesAgo: 12,
      tool: 'mcp__odoo__timesheet_create',
      input: {
        projectId: 201,
        date: today,
        hours: 3.5,
        description: 'Reprise des tags OPC UA côté convoyeur',
      },
    },
    {
      title: 'Répondre à Marc Dufour',
      prompt: 'Réponds à Marc Dufour pour confirmer la mise en service de la ligne 3.',
      minutesAgo: 8,
      tool: 'mcp__m365__send-mail',
      input: mailInput({
        subject: 'RE: Planning de la mise en service ligne 3',
        content:
          'Bonjour Marc,\n\nJe te confirme la mise en service jeudi à 8h, comme prévu.\n\nMeilleures salutations,\nDylan',
        to: ['marc.dufour@romandie-automation.example'],
      }),
    },
    {
      title: 'Envoyer l’offre extension vision',
      prompt:
        'Envoie l’offre pour l’extension du contrôle vision à Léman Packaging, avec les pièces jointes.',
      minutesAgo: 34,
      tool: 'mcp__m365__send-mail',
      input: mailInput({
        subject: 'Offre — extension du contrôle vision au poste 3 de la ligne de conditionnement',
        content: LONG_OFFER_MAIL,
        to: ['claire.rochat@leman-packaging.example', 'production@leman-packaging.example'],
        cc: ['achats@leman-packaging.example', 'julien.favre@romandie-automation.example'],
        attachments: [
          'Offre-2026-118-extension-vision.pdf',
          'Schema-implantation-poste3.pdf',
          'Fiche-technique-camera-5MP.pdf',
        ],
      }),
    },
    {
      title: 'Confirmer la visite à la fromagerie',
      prompt: 'Confirme à la Fromagerie du Jorat que je passe demain pour l’alarme de la cave 2.',
      minutesAgo: 3,
      tool: 'mcp__m365__send-mail',
      input: mailInput({
        subject: 'Alarme cave 2',
        content: 'Bonjour,\n\nJe passe demain à 9h.\n\nDylan',
        to: ['contact@fromagerie-jorat.example'],
      }),
    },
    {
      title: 'Saisir l’intervention de nuit',
      prompt: 'Saisis l’intervention de cette nuit sur le contrôle vision de Léman Packaging.',
      minutesAgo: 140,
      tool: 'mcp__odoo__timesheet_create',
      input: {
        projectId: 203,
        date: today,
        hours: 0.75,
        description:
          'Intervention de nuit : diagnostic du défaut de tri au poste 3, remplacement du câble caméra, contrôle des rejets sur deux heures de production et rédaction du compte rendu pour l’équipe qualité',
      },
    },
    {
      title: 'Rédiger le rapport de mise en service',
      prompt: 'Rédige le rapport de mise en service de la ligne 3 dans le dossier du projet.',
      minutesAgo: 55,
      tool: 'mcp__filesystem__write_file',
      input: {
        path: 'Projets/Romandie Automation/Ligne 3/rapport-mise-en-service.md',
        content: COMMISSIONING_REPORT,
      },
    },
  ];
}

export async function seedDemo(deps: DemoSeedDeps): Promise<DemoSeedResult> {
  const now = deps.now();
  const items = await deps.upsertItems(
    buildDemoItems(now, sourceIds(await deps.listConnectors()), deps.timeZone),
  );
  await deps.bootstrapBrain();
  const syntheses = await seedDemoSyntheses(deps.syntheses);
  if ((await deps.listJobs()).length > 0) {
    return { items, syntheses, jobs: 0, approvals: 0 };
  }
  const agent = (await deps.listAgents()).find((candidate) => candidate.enabled);
  if (!agent) {
    return { items, syntheses, jobs: 0, approvals: 0 };
  }

  const summary = await deps.createJob(
    demoJob(agent.id, {
      title: 'Résumé des mails de la matinée',
      prompt: 'Résume les mails non lus de ce matin et signale ce qui est urgent.',
      status: 'done',
      startedAt: minutesAgo(now, 95),
      endedAt: minutesAgo(now, 93),
      resultText:
        '3 mails non lus. Urgent : Marc Dufour attend une date de mise en service ligne 3 avant 10h30. ' +
        'À traiter aujourd’hui : alarme cave 2 (Fromagerie du Jorat) et demande d’offre vision (Léman Packaging).',
    }),
  );
  await deps.appendEvent({
    jobId: summary.id,
    at: minutesAgo(now, 93),
    type: 'end',
    summary: 'Terminé',
  });

  await deps.createJob(
    demoJob(agent.id, {
      title: 'Préparer l’offre extension vision',
      prompt: 'Prépare une offre pour l’extension du contrôle vision au poste 3 de Léman Packaging.',
      status: 'failed',
      startedAt: minutesAgo(now, 60),
      endedAt: minutesAgo(now, 58),
      error: 'Modèle d’offre introuvable (données de démonstration)',
    }),
  );

  const settle = (jobId: string, request: Promise<unknown>) =>
    request
      .then(async (decision) => {
        if (typeof decision !== 'object' || decision === null || !('status' in decision)) {
          return;
        }
        const approved = decision.status !== 'rejected';
        await deps.updateJob(jobId, {
          status: approved ? 'done' : 'cancelled',
          endedAt: deps.now().toISOString(),
          resultText: approved
            ? 'Validation acceptée. Mode démo : aucune action réelle n’a été exécutée.'
            : 'Validation refusée. Mode démo : aucune action réelle n’a été exécutée.',
        });
      })
      .catch((error: unknown) => deps.onLog(`[demo] validation de démo non traitée : ${String(error)}`));

  const pendingApprovals = demoApprovals(now);
  for (const approval of pendingApprovals) {
    const job = await deps.createJob(
      demoJob(agent.id, {
        title: approval.title,
        prompt: approval.prompt,
        status: 'waiting_approval',
        startedAt: minutesAgo(now, approval.minutesAgo),
      }),
    );
    settle(job.id, deps.requestApproval(job.id, approval.tool, approval.input));
  }
  return { items, syntheses, jobs: 2 + pendingApprovals.length, approvals: pendingApprovals.length };
}
