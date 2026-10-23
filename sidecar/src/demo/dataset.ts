import type { ItemUpsert } from '@regis/shared';
import { mapEvent, mapMessage, toUpsert } from '../sync/m365';
import { mapInvoice, mapPartner, mapProject, mapTask, mapTimesheet, todayIn } from '../sync/odoo';

export interface DemoSourceIds {
  m365: string;
  odoo: string;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const ME = { name: 'Alex Morel', address: 'dylan@regis-demo.example' };

const PARTNERS = {
  romandie: [101, 'Romandie Automation SA'],
  jorat: [102, 'Fromagerie du Jorat'],
  leman: [103, 'Léman Packaging Sàrl'],
  claire: [104, 'Claire Rochat'],
} as const satisfies Record<string, readonly [number, string]>;

const PROJECTS = {
  scada: [201, 'Migration SCADA ligne 3'],
  hmi: [202, 'Maintenance HMI caves'],
  vision: [203, 'Contrôle vision emballage'],
} as const satisfies Record<string, readonly [number, string]>;

const TASKS = {
  tags: [301, 'Reprise des tags OPC UA'],
  tests: [302, 'Tests de réception usine'],
  alarms: [303, 'Refonte des alarmes HMI'],
  camera: [304, 'Calibration caméra poste 2'],
  offer: [305, 'Offre extension vision'],
} as const satisfies Record<string, readonly [number, string]>;

function ref(entry: readonly [number, string]): [number, string] {
  return [entry[0], entry[1]];
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function zoneOffset(day: string, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value;
  const offset = name?.replace('GMT', '') ?? '';
  return offset === '' ? 'Z' : offset;
}

function localTime(day: string, time: string, timeZone: string): string {
  return `${day}T${time}:00${zoneOffset(day, timeZone)}`;
}

function hoursAgo(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * MS_PER_HOUR).toISOString();
}

function person(name: string, address: string) {
  return { emailAddress: { name, address } };
}

function demoMessages(now: Date) {
  const message = (
    id: string,
    hours: number,
    from: ReturnType<typeof person>,
    subject: string,
    preview: string,
    extra: { isRead?: boolean; importance?: string; conversationId?: string } = {},
  ) => ({
    id: `demo-mail-${id}`,
    subject,
    bodyPreview: preview,
    receivedDateTime: hoursAgo(now, hours),
    from,
    toRecipients: [person(ME.name, ME.address)],
    isRead: extra.isRead ?? false,
    importance: extra.importance ?? 'normal',
    conversationId: extra.conversationId ?? `demo-conv-${id}`,
  });
  const marc = person('Marc Dufour', 'marc.dufour@romandie-automation.example');
  const claire = person('Claire Rochat', 'claire.rochat@jorat.example');
  const sophie = person('Sophie Berset', 'sophie.berset@leman-packaging.example');
  return [
    message(
      'scada-planning',
      1.5,
      marc,
      'Planning de la mise en service ligne 3',
      'Bonjour Dylan, peux-tu me confirmer la date de mise en service avant 10h30 ? La production doit valider le créneau.',
      { importance: 'high' },
    ),
    message(
      'hmi-alarm',
      3,
      claire,
      'Alarme récurrente sur la cave 2',
      "L'alarme de température cave 2 se déclenche toutes les nuits vers 3h. Est-ce un seuil mal réglé ?",
    ),
    message(
      'vision-offer',
      5,
      sophie,
      "Demande d'offre : extension contrôle vision",
      'Nous aimerions étendre le contrôle vision au poste 3. Pouvez-vous nous faire une offre ?',
    ),
    message(
      'invoice-reminder',
      20,
      person('Comptabilité Léman Packaging', 'compta@leman-packaging.example'),
      'Facture FAC/2026/0141',
      'Nous avons bien reçu votre facture, le paiement est prévu en fin de mois.',
      { isRead: true },
    ),
    message(
      'scada-tags',
      26,
      marc,
      'Liste des tags OPC UA',
      'Voici la liste à jour des tags OPC UA pour la reprise. Il en manque une vingtaine côté convoyeur.',
      { isRead: true, conversationId: 'demo-conv-scada-planning' },
    ),
    message(
      'newsletter',
      30,
      person('Swiss Automation News', 'news@automation-news.example'),
      'Les tendances de l’automation en 2027',
      'Edge computing, OPC UA FX et IA embarquée : notre sélection du mois.',
      { isRead: true },
    ),
  ];
}

const DEMO_TEAMS_URL = 'https://teams.microsoft.com/l/meetup-join/demo-standup';

function demoEvents(today: string, timeZone: string) {
  const event = (
    id: string,
    day: string,
    start: string,
    end: string,
    subject: string,
    location: string | null,
    attendees: ReturnType<typeof person>[] = [],
    joinUrl: string | null = null,
  ) => ({
    id: `demo-event-${id}`,
    subject,
    bodyPreview: null,
    start: { dateTime: localTime(day, start, timeZone), timeZone: null },
    end: { dateTime: localTime(day, end, timeZone), timeZone: null },
    location: location ? { displayName: location } : null,
    organizer: person(ME.name, ME.address),
    attendees: attendees.map((attendee) => ({
      ...attendee,
      type: 'required',
      status: { response: 'accepted' },
    })),
    isAllDay: false,
    isCancelled: false,
    isOnlineMeeting: joinUrl !== null,
    onlineMeetingProvider: joinUrl ? 'teamsForBusiness' : null,
    onlineMeeting: joinUrl ? { joinUrl } : null,
  });
  return [
    event('standup', today, '08:30', '08:45', 'Point équipe', 'Teams', [], DEMO_TEAMS_URL),
    event(
      'scada',
      today,
      '10:30',
      '11:30',
      'Validation mise en service ligne 3',
      'Romandie Automation, Ecublens',
      [person('Marc Dufour', 'marc.dufour@romandie-automation.example')],
    ),
    event('jorat', today, '14:00', '15:00', 'Visite caves — alarmes HMI', 'Fromagerie du Jorat, Mézières', [
      person('Claire Rochat', 'claire.rochat@jorat.example'),
    ]),
    event(
      'vision',
      shiftDay(today, 1),
      '09:00',
      '10:00',
      'Atelier vision poste 3',
      'Léman Packaging, Morges',
    ),
    event('review', shiftDay(today, 2), '16:00', '17:00', 'Revue de projet SCADA', 'Teams'),
    event(
      'fat',
      shiftDay(today, 4),
      '08:00',
      '12:00',
      'Tests de réception usine',
      'Romandie Automation, Ecublens',
    ),
  ];
}

function demoPartners() {
  return [
    {
      id: PARTNERS.romandie[0],
      name: PARTNERS.romandie[1],
      email: 'info@romandie-automation.example',
      is_company: true,
    },
    { id: PARTNERS.jorat[0], name: PARTNERS.jorat[1], email: 'contact@jorat.example', is_company: true },
    {
      id: PARTNERS.leman[0],
      name: PARTNERS.leman[1],
      email: 'info@leman-packaging.example',
      is_company: true,
    },
    {
      id: PARTNERS.claire[0],
      name: PARTNERS.claire[1],
      email: 'claire.rochat@jorat.example',
      is_company: false,
      parent_id: ref(PARTNERS.jorat),
    },
  ];
}

function demoProjects(today: string) {
  return [
    {
      id: PROJECTS.scada[0],
      name: PROJECTS.scada[1],
      partner_id: ref(PARTNERS.romandie),
      date_start: shiftDay(today, -60),
      date: shiftDay(today, 30),
      description: '<p>Remplacement du SCADA de la ligne 3 et reprise des tags OPC UA.</p>',
    },
    {
      id: PROJECTS.hmi[0],
      name: PROJECTS.hmi[1],
      partner_id: ref(PARTNERS.jorat),
      date_start: shiftDay(today, -200),
      description: '<p>Contrat de maintenance des écrans de supervision des caves.</p>',
    },
    {
      id: PROJECTS.vision[0],
      name: PROJECTS.vision[1],
      partner_id: ref(PARTNERS.leman),
      date_start: shiftDay(today, -20),
      description: '<p>Contrôle vision des étiquettes sur la ligne d’emballage.</p>',
    },
  ];
}

function demoTasks(today: string) {
  const task = (
    entry: readonly [number, string],
    project: readonly [number, string],
    partner: readonly [number, string],
    deadlineDays: number,
    stage: string,
    priority = '0',
  ) => ({
    id: entry[0],
    name: entry[1],
    project_id: ref(project),
    partner_id: ref(partner),
    stage_id: [entry[0] + 1000, stage],
    date_deadline: shiftDay(today, deadlineDays),
    priority,
    state: '01_in_progress',
  });
  return [
    task(TASKS.tags, PROJECTS.scada, PARTNERS.romandie, 1, 'En cours', '1'),
    task(TASKS.tests, PROJECTS.scada, PARTNERS.romandie, 4, 'À faire'),
    task(TASKS.alarms, PROJECTS.hmi, PARTNERS.jorat, 0, 'En cours', '1'),
    task(TASKS.camera, PROJECTS.vision, PARTNERS.leman, 6, 'À faire'),
    task(TASKS.offer, PROJECTS.vision, PARTNERS.leman, 2, 'À faire'),
  ];
}

function demoTimesheets(today: string) {
  const monday = shiftDay(today, -weekdayIndex(today));
  const lines: Array<[number, string, readonly [number, string], readonly [number, string], number]> = [
    [0, 'Reprise des tags convoyeur', PROJECTS.scada, TASKS.tags, 4],
    [0, 'Analyse alarmes cave 2', PROJECTS.hmi, TASKS.alarms, 2.5],
    [1, 'Reprise des tags OPC UA', PROJECTS.scada, TASKS.tags, 6],
    [1, 'Préparation atelier vision', PROJECTS.vision, TASKS.camera, 1.5],
    [2, 'Scripts de test FAT', PROJECTS.scada, TASKS.tests, 5],
    [3, 'Calibration caméra', PROJECTS.vision, TASKS.camera, 3],
  ];
  return lines
    .map(([offset, name, project, task, hours], index) => ({
      id: 401 + index,
      date: shiftDay(monday, offset),
      name,
      unit_amount: hours,
      project_id: ref(project),
      task_id: ref(task),
    }))
    .filter((line) => line.date < today);
}

function demoInvoices(today: string) {
  const chf: [number, string] = [5, 'CHF'];
  return [
    {
      id: 501,
      name: 'FAC/2026/0128',
      partner_id: ref(PARTNERS.jorat),
      invoice_date: shiftDay(today, -45),
      invoice_date_due: shiftDay(today, -15),
      amount_total: 4860,
      currency_id: chf,
      payment_state: 'not_paid',
      state: 'posted',
    },
    {
      id: 502,
      name: 'FAC/2026/0141',
      partner_id: ref(PARTNERS.leman),
      invoice_date: shiftDay(today, -10),
      invoice_date_due: shiftDay(today, 20),
      amount_total: 12350,
      currency_id: chf,
      payment_state: 'not_paid',
      state: 'posted',
    },
    {
      id: 503,
      name: 'FAC/2026/0135',
      partner_id: ref(PARTNERS.romandie),
      invoice_date: shiftDay(today, -25),
      invoice_date_due: shiftDay(today, 5),
      amount_total: 18400,
      currency_id: chf,
      payment_state: 'paid',
      state: 'posted',
    },
  ];
}

export function buildDemoItems(now: Date, sources: DemoSourceIds, timeZone: string): ItemUpsert[] {
  const today = todayIn(timeZone, now);
  return [
    ...demoMessages(now).map((raw) => mapMessage(raw, sources.m365)),
    ...demoEvents(today, timeZone).map((raw) => mapEvent(raw, sources.m365)),
    ...demoPartners().map((raw) => mapPartner(raw, sources.odoo)),
    ...demoProjects(today).map((raw) => mapProject(raw, sources.odoo)),
    ...demoTasks(today).map((raw) => mapTask(raw, sources.odoo)),
    ...demoTimesheets(today).map((raw) => mapTimesheet(raw, sources.odoo)),
    ...demoInvoices(today).map((raw) => mapInvoice(raw, sources.odoo, today)),
  ].map(toUpsert);
}
