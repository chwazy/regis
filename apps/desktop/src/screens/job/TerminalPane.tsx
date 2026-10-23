import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '../../lib/tauri-bridge';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import controls from '../../components/ui/controls.module.css';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { bindTerminalIo, decodeBase64, terminalTheme } from './terminal';
import styles from './job.module.css';

interface TerminalPaneProps {
  jobId: string;
  resume: boolean;
  onEnded: () => void;
}

const FONT_SIZE = 13;

export function TerminalPane({ jobId, resume, onEnded }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const requestCloseRef = useRef<(() => void) | null>(null);
  const onEndedRef = useRef(onEnded);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    const styleSource = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: FONT_SIZE,
      fontFamily: styleSource.getPropertyValue('--font-mono').trim() || 'monospace',
      theme: terminalTheme(styleSource),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    let disposed = false;
    let opened = false;
    let launching = false;
    let exited = false;
    let closeRequested = false;
    const unlisteners: UnlistenFn[] = [];
    const stopListening = () => {
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };
    const endSession = (code: number | null, requested: boolean) =>
      sidecarCall('jobs.endPty', { jobId, code, requested }).catch((reason: unknown) => {
        if (!disposed) {
          setError(errorMessage(reason));
        }
      });
    const requestClose = () => {
      if (!opened || exited || closeRequested) {
        return;
      }
      closeRequested = true;
      invokeCmd('pty_close', { id: jobId }).catch(() => {
        exited = true;
        stopListening();
        void endSession(null, true).then(() => onEndedRef.current());
      });
    };
    requestCloseRef.current = requestClose;

    const binding = bindTerminalIo(terminal, jobId, invokeCmd, () => opened && !exited);
    terminal.attachCustomKeyEventHandler((event) => {
      const isCopy = event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c';
      if (isCopy && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    const launch = async () => {
      const dataUnlisten = await listen<string>(`pty://${jobId}/data`, (event) => {
        if (!disposed) {
          terminal.write(decodeBase64(event.payload));
        }
      });
      const exitUnlisten = await listen(`pty://${jobId}/exit`, () => {
        exited = true;
        stopListening();
        if (!disposed) {
          terminal.write('\r\n[terminal fermé]\r\n');
        }
        onEndedRef.current();
      });
      unlisteners.push(dataUnlisten, exitUnlisten);
      if (disposed) {
        stopListening();
        return;
      }
      launching = true;
      try {
        await sidecarCall('jobs.openPty', {
          jobId,
          resume,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      } catch (reason) {
        launching = false;
        stopListening();
        setError(errorMessage(reason));
        onEndedRef.current();
        return;
      }
      launching = false;
      opened = true;
      if (disposed) {
        requestClose();
        return;
      }
      terminal.focus();
    };
    const starter = window.setTimeout(() => void launch(), 0);

    return () => {
      disposed = true;
      window.clearTimeout(starter);
      observer.disconnect();
      binding.dispose();
      requestCloseRef.current = null;
      terminal.dispose();
      if (opened && !exited) {
        requestClose();
      } else if (!opened && !launching) {
        stopListening();
      }
    };
  }, [jobId, resume]);

  return (
    <section aria-label="Terminal" className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Terminal</h2>
        <button type="button" className={controls.secondarySm} onClick={() => requestCloseRef.current?.()}>
          Fermer le terminal
        </button>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      <div ref={hostRef} className={styles.terminalHost} />
    </section>
  );
}
