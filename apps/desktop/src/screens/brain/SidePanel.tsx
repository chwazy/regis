import { useState } from 'react';
import { Link } from 'react-router';
import type { EntityNote, LinkedEntity } from '@regis/shared';
import { DictationButton } from '../../components/DictationButton';
import controls from '../../components/ui/controls.module.css';
import { formatDay } from '../../lib/format';
import { entityPath, transcriptPath } from '../../lib/paths';
import { useTimezone } from '../../lib/use-timezone';
import { useDictationField } from '../../lib/use-dictation';
import { transcriptLinkState } from '../transcript/transcript-view';
import { KIND_LABELS, minutesPath } from './brain-view';
import styles from './brain.module.css';

const TRANSCRIPT_NOTE_TYPE = 'transcript';
const MINUTES_NOTE_TYPE = 'minutes';

interface SidePanelProps {
  /** Entité affichée : le retour depuis une transcription y ramène. */
  entityId: string;
  notes: EntityNote[];
  links: LinkedEntity[];
  onAddNote: (text: string) => Promise<void>;
}

export function SidePanel({ entityId, notes, links, onAddNote }: SidePanelProps) {
  const timezone = useTimezone();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const { ref: fieldRef, remember, onText: insertText } = useDictationField(text, setText);
  const canSubmit = !saving && text.trim() !== '';

  const submit = () => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    onAddNote(text)
      .then(() => setText(''))
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  return (
    <aside aria-label="Notes et liens" className={styles.side}>
      <section aria-label="Notes" className={styles.notesSection}>
        <h2 className={styles.sectionTitle}>Notes</h2>
        <textarea
          aria-label="Nouvelle note"
          ref={fieldRef}
          className={controls.textarea}
          rows={4}
          placeholder="Écrire une note… l’agent en extrait les faits."
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className={styles.noteActions}>
          <span className={styles.noteHint}>Ctrl+Entrée</span>
          <span className={styles.dictation} onMouseDownCapture={remember}>
            <DictationButton onText={insertText} disabled={saving} />
          </span>
          <button type="button" className={controls.primarySm} disabled={!canSubmit} onClick={submit}>
            Ajouter
          </button>
        </div>
        <div className={styles.notesList}>
          {notes.length === 0 && <p className={styles.empty}>Aucune note.</p>}
          {notes.map((note) => (
            <article key={note.id} className={styles.note}>
              <span className={styles.noteDate}>{formatDay(note.at, timezone)}</span>
              {note.noteType === TRANSCRIPT_NOTE_TYPE ? (
                <Link
                  className={styles.transcriptLink}
                  to={transcriptPath(note.id)}
                  state={transcriptLinkState(entityId)}
                >
                  Transcription — {note.text}
                </Link>
              ) : note.noteType === MINUTES_NOTE_TYPE && note.sourceId !== null ? (
                <Link
                  className={styles.transcriptLink}
                  to={minutesPath(note.sourceId)}
                  state={transcriptLinkState(entityId)}
                >
                  {note.text}
                </Link>
              ) : (
                <p className={styles.noteText}>{note.text}</p>
              )}
            </article>
          ))}
        </div>
      </section>
      <section aria-label="Liens" className={styles.section}>
        <h2 className={styles.sectionTitle}>Liens</h2>
        {links.length === 0 && <p className={styles.empty}>Aucun lien.</p>}
        {links.map((link) => (
          <Link key={link.linkId} className={styles.linkRow} to={entityPath(link.entity.id)}>
            <span className={styles.linkRel}>{KIND_LABELS[link.entity.kind].toLowerCase()}</span>
            <span className={styles.linkName}>{link.entity.name}</span>
          </Link>
        ))}
      </section>
    </aside>
  );
}
