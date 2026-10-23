import { useEffect, useState, type FormEvent } from 'react';
import type { Connector, ToolInfo } from '@regis/shared';
import { ErrorMessage } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/format';
import { invokeCmd, sidecarCall } from '../../lib/ipc';
import { parseToolArgs } from '../../widgets/format';
import { DEFAULT_MCP_REFRESH_MINUTES, type McpToolConfig } from '../../widgets/McpToolWidget';
import styles from './dashboard.module.css';

export const MCP_TOOL_ALLOWLIST_SETTING = 'widgets.mcpToolAllowlist';

interface McpToolFormProps {
  onAdd: (title: string, config: McpToolConfig) => void;
  onCancel: () => void;
}

function parseAllowlist(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

async function allowTool(qualifiedName: string): Promise<void> {
  const raw = await invokeCmd<string | null>('get_setting', { key: MCP_TOOL_ALLOWLIST_SETTING });
  const current = parseAllowlist(raw);
  if (!current.includes(qualifiedName)) {
    await invokeCmd('set_setting', {
      key: MCP_TOOL_ALLOWLIST_SETTING,
      value: JSON.stringify([...current, qualifiedName]),
    });
  }
}

export function McpToolForm({ onAdd, onCancel }: McpToolFormProps) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [connectorId, setConnectorId] = useState('');
  const [toolName, setToolName] = useState('');
  const [argsText, setArgsText] = useState('');
  const [refreshMinutes, setRefreshMinutes] = useState(DEFAULT_MCP_REFRESH_MINUTES);
  const [allowWithoutHint, setAllowWithoutHint] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invokeCmd<Connector[]>('list_connectors')
      .then(setConnectors)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const selectConnector = (id: string) => {
    setConnectorId(id);
    setToolName('');
    setTools([]);
    if (id === '') {
      return;
    }
    sidecarCall<ToolInfo[]>('mcp.listTools', { connectorId: id })
      .then((listed) => setTools(listed.filter((tool) => tool.access === 'read')))
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const selectedTool = tools.find((tool) => tool.name === toolName);
  const needsAllowlist = selectedTool !== undefined && selectedTool.readOnlyHint !== true;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const args = parseToolArgs(argsText);
    if (!args.ok) {
      setError(args.error);
      return;
    }
    if (selectedTool === undefined) {
      return;
    }
    if (needsAllowlist && !allowWithoutHint) {
      setError(
        'Cet outil n’indique pas explicitement qu’il est en lecture seule : autorise-le pour continuer.',
      );
      return;
    }
    const config: McpToolConfig = { connectorId, tool: toolName, args: args.value, refreshMinutes };
    const register = needsAllowlist ? allowTool(selectedTool.qualifiedName) : Promise.resolve();
    register.then(() => onAdd(toolName, config)).catch((reason: unknown) => setError(errorMessage(reason)));
  };

  return (
    <form className={styles.mcpForm} onSubmit={submit}>
      <label className={styles.field}>
        Connecteur
        <select value={connectorId} onChange={(event) => selectConnector(event.target.value)} required>
          <option value="">Choisir…</option>
          {connectors.map((connector) => (
            <option key={connector.id} value={connector.id}>
              {connector.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Outil (lecture)
        <select value={toolName} onChange={(event) => setToolName(event.target.value)} required>
          <option value="">Choisir…</option>
          {tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Arguments (JSON)
        <textarea
          rows={2}
          value={argsText}
          placeholder='{"days": 7}'
          onChange={(event) => setArgsText(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        Rafraîchir toutes les (min)
        <input
          type="number"
          min={1}
          value={refreshMinutes}
          onChange={(event) => setRefreshMinutes(Math.max(1, Number(event.target.value) || 1))}
        />
      </label>
      {needsAllowlist && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={allowWithoutHint}
            onChange={(event) => setAllowWithoutHint(event.target.checked)}
          />
          Autoriser cet outil malgré l’absence d’indication de lecture seule
        </label>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      <div className={styles.formActions}>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className={styles.primary}>
          Ajouter
        </button>
      </div>
    </form>
  );
}
