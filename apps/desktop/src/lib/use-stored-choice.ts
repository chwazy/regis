import { useCallback, useState } from 'react';

function read<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return choices.find((choice) => choice === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

/** Choix d'affichage mémorisé par poste (confort local, pas une donnée). */
export function useStoredChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState(() => read(key, choices, fallback));
  const choose = useCallback(
    (next: T) => {
      store(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, choose];
}
