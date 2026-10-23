import { z } from 'zod';
import type { Agent } from '@regis/shared';
import {
  DriverUnavailableError,
  TEST_PROMPT,
  type AgentDriver,
  type AgentEvent,
  type AgentRunInput,
  type AgentTestResult,
} from './driver';

export const OLLAMA_URL_SETTING = 'ollama.url';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

const chatResponse = z.object({
  model: z.string().optional(),
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

export interface OllamaDeps {
  getSetting: (key: string) => Promise<string | null>;
  fetch?: typeof fetch;
}

export async function resolveOllamaUrl(getSetting: OllamaDeps['getSetting']): Promise<string> {
  return ((await getSetting(OLLAMA_URL_SETTING)) || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
}

export class OllamaDriver implements AgentDriver {
  readonly runtime = 'ollama' as const;

  constructor(private readonly deps: OllamaDeps) {}

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const model = this.requireModel(input.agent);
    yield { type: 'start', model };
    const messages = [
      ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
      { role: 'user', content: input.prompt },
    ];
    let reply: z.infer<typeof chatResponse>;
    try {
      reply = await this.chat(
        { model, messages, stream: false, ...(input.jsonOutput === true ? { format: 'json' } : {}) },
        input.signal,
      );
    } catch (error) {
      if (input.signal.aborted) {
        yield { type: 'end', resultText: '', isError: true, subtype: 'aborted' };
        return;
      }
      if (error instanceof DriverUnavailableError) {
        throw error;
      }
      yield { type: 'error', message: errorMessage(error) };
      return;
    }
    const text = reply.message.content;
    if (text !== '') {
      yield { type: 'message', text };
    }
    yield {
      type: 'usage',
      costUsd: 0,
      tokensIn: reply.prompt_eval_count ?? 0,
      tokensOut: reply.eval_count ?? 0,
    };
    yield { type: 'end', resultText: text, isError: false, subtype: 'success' };
  }

  async test(agent: Agent): Promise<AgentTestResult> {
    const startedAt = Date.now();
    try {
      await this.chat(
        {
          model: this.requireModel(agent),
          messages: [{ role: 'user', content: TEST_PROMPT }],
          stream: false,
        },
        AbortSignal.timeout(60_000),
      );
      return { ok: true, latencyMs: Date.now() - startedAt, costUsd: 0 };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, costUsd: 0, error: errorMessage(error) };
    }
  }

  private requireModel(agent: Agent): string {
    if (!agent.model) {
      throw new DriverUnavailableError('Aucun modèle Ollama configuré pour cet agent');
    }
    return agent.model;
  }

  private async chat(body: unknown, signal: AbortSignal): Promise<z.infer<typeof chatResponse>> {
    const url = await resolveOllamaUrl(this.deps.getSetting);
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new DriverUnavailableError(`Ollama est injoignable (${url}) : ${errorMessage(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Ollama a répondu ${response.status} : ${(await response.text()).slice(0, 300)}`);
    }
    return chatResponse.parse(await response.json());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
