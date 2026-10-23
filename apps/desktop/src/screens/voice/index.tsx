import { LocalModuleRow } from '../../components/LocalModuleRow';
import { PageHeader } from '../../components/ui/PageHeader';
import { useLocalModules } from '../../lib/use-local-modules';
import styles from './voice.module.css';
import { VoiceSection } from './VoiceSection';

export default function VoiceSettingsScreen() {
  const { modules } = useLocalModules();
  const voice = modules.find((module) => module.id === 'voice');
  return (
    <div className={styles.page}>
      <PageHeader title="Voix & transcription" />
      {voice && (
        <section className={styles.card} aria-label="Module voix">
          <LocalModuleRow module={voice} />
        </section>
      )}
      {voice?.state === 'on' && <VoiceSection />}
    </div>
  );
}
