import { useSyncExternalStore } from 'react';

// Conversation de l'orchestrateur gardée en mémoire : elle survit aux changements d'écran
// et disparaît à la fermeture de l'app ou quand l'utilisateur l'efface.
let currentChatJobId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setChatJobId(chatJobId: string | null): void {
  if (chatJobId === currentChatJobId) {
    return;
  }
  currentChatJobId = chatJobId;
  for (const listener of listeners) {
    listener();
  }
}

export function useChatJobId(): string | null {
  return useSyncExternalStore(subscribe, () => currentChatJobId);
}
