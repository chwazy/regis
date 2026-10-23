/** Largeur de page et onglet actif, dérivés du chemin : une seule table pour toute l'app. */

export type PageLayout = 'narrow' | 'default' | 'wide' | 'full';

const LAYOUTS: readonly { prefix: string; layout: PageLayout }[] = [
  { prefix: '/agents', layout: 'full' },
  { prefix: '/jobs/', layout: 'wide' },
  { prefix: '/dashboard', layout: 'wide' },
  { prefix: '/cerveau', layout: 'wide' },
  { prefix: '/transcripts/', layout: 'narrow' },
  { prefix: '/reglages', layout: 'wide' },
];

function matches(pathname: string, prefix: string): boolean {
  return prefix.endsWith('/')
    ? pathname.startsWith(prefix)
    : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function pageLayout(pathname: string): PageLayout {
  if (pathname === '/') {
    return 'wide';
  }
  return LAYOUTS.find((entry) => matches(pathname, entry.prefix))?.layout ?? 'default';
}

/** Un onglet de nav est actif sur sa route et sur les pages de détail qui en dépendent. */
export function isNavActive(item: { to: string; also?: readonly string[] }, pathname: string): boolean {
  if (item.to === '/') {
    return pathname === '/';
  }
  return [item.to, ...(item.also ?? [])].some((prefix) => matches(pathname, prefix));
}

export function isSettingsPath(pathname: string): boolean {
  return matches(pathname, '/reglages');
}
