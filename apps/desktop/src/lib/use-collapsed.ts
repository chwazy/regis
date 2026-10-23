import { useCallback, useState } from 'react';

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function store(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    return;
  }
}

/** État replié d'une section, mémorisé par poste (confort local, pas une donnée). */
export function useCollapsed(key: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => read(key));
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      store(key, !current);
      return !current;
    });
  }, [key]);
  return [collapsed, toggle];
}
