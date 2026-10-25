// Le binaire packagé n'embarque que l'ICU anglais : `format()` d'une locale comme 'en-CA'
// retombe sur 'en-US' (« 10/25/2026 »), d'où l'assemblage à partir des parties numériques.
export function calendarDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
