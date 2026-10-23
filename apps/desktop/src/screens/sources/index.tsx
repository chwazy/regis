import { useCallback, useEffect, useState } from 'react';
import type { TemplateSummary } from '@regis/shared';
import { PageHeader } from '../../components/ui/PageHeader';
import { errorMessage } from '../../lib/format';
import { invokeCmd, onRegisEvent, sidecarCall } from '../../lib/ipc';
import { ImportSection } from './ImportSection';
import { SourcesSection } from './SourcesSection';
import { TemplateWorkshop } from './TemplateWorkshop';
import { TemplatesSection } from './TemplatesSection';
import styles from './sources.module.css';

export default function SourcesScreen() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfAvailable, setPdfAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      invokeCmd<TemplateSummary[]>('list_templates')
        .then((loaded) => {
          setTemplates(loaded);
          setError(null);
        })
        .catch((reason: unknown) => setError(errorMessage(reason))),
    [],
  );

  useEffect(() => {
    void refresh();
    sidecarCall<{ pdf: boolean }>('templates.capabilities')
      .then((capabilities) => setPdfAvailable(capabilities.pdf))
      .catch(() => undefined);
    const unlisten = onRegisEvent('job.updated', () => void refresh());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [refresh]);

  const importTemplate = (path: string) =>
    invokeCmd<TemplateSummary>('import_template', { path })
      .then((imported) => {
        setSelectedId(imported.template.id);
        return refresh();
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
        throw reason;
      });

  const selected = templates.find((summary) => summary.template.id === selectedId);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Modèles &amp; sources"
        subtitle="Gère ce qui alimente le Cerveau. Pour chercher un document, passe par le Cerveau."
      />
      <div className={styles.layout}>
        <div className={styles.main}>
          <ImportSection />
          <TemplatesSection
            templates={templates}
            selectedId={selectedId}
            error={error}
            onSelect={setSelectedId}
            onImport={importTemplate}
          />
          <SourcesSection />
        </div>
        {selected && (
          <TemplateWorkshop
            key={selected.template.id}
            summary={selected}
            pdfAvailable={pdfAvailable}
            onRefresh={refresh}
          />
        )}
      </div>
    </div>
  );
}
