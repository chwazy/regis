import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DictationResult, SttStatus } from '@regis/shared';
import { invokeCmd, onRegisEvent } from './ipc';
import { insertAtCursor } from './insert-at-cursor';

export type DictationState = 'idle' | 'listening' | 'transcribing' | 'error' | 'unavailable';

export interface UseDictation {
  state: DictationState;
  elapsedMs: number;
  level: number;
  /** Message d'erreur, ou raison d'indisponibilité quand `state === 'unavailable'`. */
  error: string | null;
  toggle: () => void;
  cancel: () => void;
}

type ActiveState = Exclude<DictationState, 'unavailable'>;

const ELAPSED_TICK_MS = 250;
const LEVEL_GAIN = 5;
const MODEL_MISSING_MESSAGE = 'Modèle de transcription non installé (Agents & comptes)';
const CAPTURE_UNSUPPORTED_MESSAGE = 'Capture audio disponible sous Windows uniquement';

export function unavailableReason(status: SttStatus): string | null {
  if (!status.captureSupported) {
    return CAPTURE_UNSUPPORTED_MESSAGE;
  }
  return status.state === 'ready' ? null : MODEL_MISSING_MESSAGE;
}

export function useDictation(onText: (text: string) => void): UseDictation {
  const [active, setActive] = useState<ActiveState>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const reasonRef = useRef<string | null>(null);

  useEffect(() => {
    onTextRef.current = onText;
  });

  useEffect(() => {
    const refreshStatus = () => {
      invokeCmd<SttStatus>('stt_status')
        .then((status) => {
          const next = unavailableReason(status);
          reasonRef.current = next;
          setReason(next);
        })
        .catch(() => undefined);
    };
    refreshStatus();
    window.addEventListener('focus', refreshStatus);
    return () => window.removeEventListener('focus', refreshStatus);
  }, []);

  const fail = useCallback((cause: unknown) => {
    sessionRef.current = null;
    setLevel(0);
    setError(String(cause));
    setActive('error');
  }, []);

  const finish = useCallback(
    (sessionId: string) => {
      sessionRef.current = null;
      setLevel(0);
      setActive('transcribing');
      invokeCmd<DictationResult>('dictation_stop', { sessionId })
        .then((result) => {
          setActive('idle');
          if (result.text.trim() !== '') {
            onTextRef.current(result.text);
          }
        })
        .catch(fail);
    },
    [fail],
  );

  const cancel = useCallback(() => {
    const sessionId = sessionRef.current;
    if (sessionId === null) {
      return;
    }
    sessionRef.current = null;
    setLevel(0);
    setActive('idle');
    invokeCmd<null>('dictation_cancel', { sessionId }).catch(() => undefined);
  }, []);

  const toggle = useCallback(() => {
    if (busyRef.current || reasonRef.current !== null) {
      return;
    }
    const sessionId = sessionRef.current;
    if (sessionId !== null) {
      finish(sessionId);
      return;
    }
    busyRef.current = true;
    setError(null);
    invokeCmd<{ sessionId: string }>('dictation_start')
      .then((started) => {
        sessionRef.current = started.sessionId;
        setElapsedMs(0);
        setActive('listening');
      })
      .catch(fail)
      .finally(() => {
        busyRef.current = false;
      });
  }, [fail, finish]);

  const listening = active === 'listening';

  useEffect(() => {
    if (!listening) {
      return undefined;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), ELAPSED_TICK_MS);
    const unlisteners = [
      onRegisEvent<{ sessionId: string; rms: number }>('dictation.level', (event) => {
        if (event.payload.sessionId === sessionRef.current) {
          setLevel(Math.min(1, event.payload.rms * LEVEL_GAIN));
        }
      }),
      onRegisEvent<{ sessionId: string }>('dictation.autoStopped', (event) => {
        if (event.payload.sessionId === sessionRef.current) {
          finish(event.payload.sessionId);
        }
      }),
    ];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown, true);
      for (const unlistener of unlisteners) {
        void unlistener.then((stop) => stop());
      }
    };
  }, [listening, finish, cancel]);

  useEffect(() => cancel, [cancel]);

  const unavailable = reason !== null && (active === 'idle' || active === 'error');
  return {
    state: unavailable ? 'unavailable' : active,
    elapsedMs,
    level,
    error: unavailable ? reason : error,
    toggle,
    cancel,
  };
}

interface FieldSelection {
  start: number;
  end: number;
}

/** Branche la dictée sur un textarea contrôlé : insertion au curseur, focus et curseur restaurés. */
export function useDictationField(value: string, setValue: (value: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<FieldSelection | null>(null);
  const pendingCursor = useRef<number | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  });

  // Le clic sur le bouton fait perdre la sélection : on la mémorise au mousedown.
  const remember = useCallback(() => {
    const field = ref.current;
    if (field) {
      selection.current = { start: field.selectionStart, end: field.selectionEnd };
    }
  }, []);

  const onText = useCallback(
    (text: string) => {
      const current = valueRef.current;
      const range = selection.current ?? { start: current.length, end: current.length };
      const result = insertAtCursor(current, range.start, range.end, text);
      pendingCursor.current = result.cursor;
      setValue(result.value);
    },
    [setValue],
  );

  useLayoutEffect(() => {
    const cursor = pendingCursor.current;
    const field = ref.current;
    if (cursor === null || !field) {
      return;
    }
    pendingCursor.current = null;
    field.focus();
    field.setSelectionRange(cursor, cursor);
    selection.current = { start: cursor, end: cursor };
  });

  return { ref, remember, onText };
}
