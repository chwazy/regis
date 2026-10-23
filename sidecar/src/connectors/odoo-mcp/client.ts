import { z } from 'zod';

export interface OdooConfig {
  url: string;
  db: string;
  login: string;
  apiKey: string;
}

export class OdooAuthError extends Error {}

export class OdooRpcError extends Error {
  constructor(
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

const rpcEnvelope = z.object({
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string().optional(),
      data: z.object({ message: z.string().optional() }).passthrough().optional(),
    })
    .passthrough()
    .optional(),
});

export class OdooClient {
  private uid: number | null = null;

  constructor(private readonly cfg: OdooConfig) {}

  async authenticate(): Promise<number> {
    const result = await this.call('common', 'authenticate', [
      this.cfg.db,
      this.cfg.login,
      this.cfg.apiKey,
      {},
    ]);
    if (typeof result !== 'number' || result <= 0) {
      throw new OdooAuthError('Authentification Odoo refusée : base, identifiant ou clé API invalide');
    }
    this.uid = result;
    return result;
  }

  async executeKw<T>(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
    schema: z.ZodType<T> = z.any(),
  ): Promise<T> {
    const uid = this.uid ?? (await this.authenticate());
    const result = await this.call('object', 'execute_kw', [
      this.cfg.db,
      uid,
      this.cfg.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      throw new OdooRpcError(`Résultat Odoo inattendu pour ${model}.${method}`, parsed.error.issues);
    }
    return parsed.data;
  }

  searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    opts: { limit?: number; order?: string } = {},
  ): Promise<T[]> {
    return this.executeKw<T[]>(
      model,
      'search_read',
      [domain],
      {
        fields,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.order === undefined ? {} : { order: opts.order }),
      },
      z.array(z.record(z.string(), z.unknown())) as unknown as z.ZodType<T[]>,
    );
  }

  private async call(service: string, method: string, args: unknown[]): Promise<unknown> {
    const endpoint = `${this.cfg.url.replace(/\/+$/, '')}/jsonrpc`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OdooRpcError(`Odoo injoignable : ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new OdooRpcError(`Odoo a répondu HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OdooRpcError(
        "Réponse Odoo illisible (JSON attendu) : l'API externe est peut-être indisponible",
      );
    }
    const envelope = rpcEnvelope.safeParse(payload);
    if (!envelope.success) {
      throw new OdooRpcError('Réponse Odoo inattendue');
    }
    if (envelope.data.error) {
      const { error } = envelope.data;
      throw new OdooRpcError(error.data?.message ?? error.message ?? 'Erreur Odoo', error.data);
    }
    return envelope.data.result;
  }
}
