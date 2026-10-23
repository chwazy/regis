import { useEffect, useState } from 'react';
import type { Recording, SttStatus } from '@regis/shared';
import { invokeCmd, onRegisEvent } from './ipc';
import { isSessionLive } from './recording';

/** Session en cours (ou en finalisation), tenue à jour par `recording.state`. */
export function useActiveRecording(): Recording | null {
  const [active, setActive] = useState<Recording | null>(null);

  useEffect(() => {
    let cancelled = false;
    invokeCmd<Recording | null>('recording_active')
      .then((recording) => {
        if (!cancelled) {
          setActive((current) => current ?? recording);
        }
      })
      .catch(() => undefined);
    const stop = onRegisEvent<Recording>('recording.state', (event) => {
      setActive(isSessionLive(event.payload) ? event.payload : null);
    });
    return () => {
      cancelled = true;
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  return active;
}

export interface RecordingCapabilities {
  captureSupported: boolean;
  loopbackSupported: boolean;
}

/** Plateforme : micro et son système (la capture système n'existe que sous Windows). */
export function useRecordingCapabilities(): RecordingCapabilities | null {
  const [capabilities, setCapabilities] = useState<RecordingCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    invokeCmd<SttStatus>('stt_status')
      .then((status) => {
        if (!cancelled) {
          setCapabilities({
            captureSupported: status.captureSupported,
            loopbackSupported: status.loopbackSupported,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}
