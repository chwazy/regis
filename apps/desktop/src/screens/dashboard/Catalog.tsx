import { useState } from 'react';
import type { CustomWidgetSpec, Widget } from '@regis/shared';
import type { McpToolConfig } from '../../widgets/McpToolWidget';
import { WIDGET_SOURCES, WIDGETS, type WidgetDefinition, type WidgetKind } from '../../widgets/registry';
import styles from './dashboard.module.css';
import { CustomWidgetDialog } from './CustomWidgetDialog';
import { McpToolForm } from './McpToolForm';

export type NewWidgetDraft = Pick<Widget, 'kind' | 'title' | 'configJson'>;

interface CatalogProps {
  onAdd: (draft: NewWidgetDraft, size: WidgetDefinition['defaultSize']) => void;
}

export function filterCatalog(query: string): { source: string; definitions: WidgetDefinition[] }[] {
  const needle = query.trim().toLowerCase();
  const definitions = Object.values(WIDGETS).filter(
    (definition) =>
      definition.kind !== 'custom' &&
      (needle === '' ||
        definition.title.toLowerCase().includes(needle) ||
        definition.source.toLowerCase().includes(needle)),
  );
  return WIDGET_SOURCES.map((source) => ({
    source,
    definitions: definitions.filter((definition) => definition.source === source),
  })).filter((group) => group.definitions.length > 0);
}

export function Catalog({ onAdd }: CatalogProps) {
  const [query, setQuery] = useState('');
  const [configuring, setConfiguring] = useState<WidgetKind | null>(null);
  const [customDescription, setCustomDescription] = useState('');
  const [generating, setGenerating] = useState<string | null>(null);

  const add = (definition: WidgetDefinition) => {
    if (definition.kind === 'mcp_tool') {
      setConfiguring(definition.kind);
      return;
    }
    onAdd(
      { kind: definition.kind, title: definition.title, configJson: definition.defaultConfig },
      definition.defaultSize,
    );
  };

  const addMcpTool = (title: string, config: McpToolConfig) => {
    const definition = WIDGETS.mcp_tool;
    onAdd({ kind: 'mcp_tool', title, configJson: config }, definition.defaultSize);
    setConfiguring(null);
  };

  const addCustom = (spec: CustomWidgetSpec) => {
    onAdd({ kind: 'custom', title: spec.title, configJson: spec }, WIDGETS.custom.defaultSize);
    setGenerating(null);
    setCustomDescription('');
  };

  return (
    <aside aria-label="Catalogue de widgets" className={styles.catalog}>
      <div className={styles.catalogHead}>
        <h2 className={styles.catalogTitle}>Ajouter un widget</h2>
        <span className={styles.muted}>Chaque widget lit le cache local ou un outil MCP en lecture.</span>
      </div>
      <label className={styles.field}>
        Filtrer le catalogue
        <input
          type="search"
          value={query}
          placeholder="Filtrer…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {filterCatalog(query).map((group) => (
        <div key={group.source} className={styles.group}>
          <span className={styles.groupTitle}>{group.source}</span>
          {group.definitions.map((definition) => (
            <div key={definition.kind} className={styles.entry}>
              <span className={styles.entryName}>{definition.title}</span>
              <button
                type="button"
                className={styles.add}
                aria-label={`Ajouter ${definition.title}`}
                onClick={() => add(definition)}
              >
                +
              </button>
            </div>
          ))}
        </div>
      ))}
      <div className={styles.customSection}>
        <span className={styles.entryName}>Widget sur mesure</span>
        <label className={styles.field}>
          Décris-le, un agent le génère
          <textarea
            rows={2}
            value={customDescription}
            placeholder="Ex. heures non facturées par client ce mois"
            onChange={(event) => setCustomDescription(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.secondary}
          disabled={customDescription.trim() === ''}
          onClick={() => setGenerating(customDescription.trim())}
        >
          Générer
        </button>
      </div>
      {generating !== null && (
        <CustomWidgetDialog description={generating} onAdd={addCustom} onClose={() => setGenerating(null)} />
      )}
      {configuring === 'mcp_tool' && <McpToolForm onAdd={addMcpTool} onCancel={() => setConfiguring(null)} />}
    </aside>
  );
}
