import { z } from 'zod';
import type { M365LoginStart, M365LoginStatus } from '@regis/shared';
import type { McpHost } from '../mcp/host';

export const M365_AUTH_TOOLS = { login: 'login', verifyLogin: 'verify-login' } as const;

const DEVICE_CODE_LIFETIME_MS = 15 * 60_000;
const DEVICE_URI_PATTERN = /https?:\/\/[^\s"'<>]+/i;
const USER_CODE_PATTERN = /\bcode\s+([A-Z0-9]{6,12})\b/;
const ENTRA_ERROR_PATTERN = /AADSTS\d+/;

const toolResult = z.object({
  isError: z.boolean().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
});

const verifyPayload = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  userData: z
    .object({
      displayName: z.string().nullish(),
      userPrincipalName: z.string().nullish(),
      mail: z.string().nullish(),
    })
    .nullish(),
});

export interface LoginTextResult {
  text: string;
  isError: boolean;
}

export function readToolText(result: unknown): LoginTextResult {
  const parsed = toolResult.safeParse(result);
  if (!parsed.success) {
    return { text: '', isError: true };
  }
  return {
    text: parsed.data.content.map((block) => block.text ?? '').join('\n'),
    isError: parsed.data.isError === true,
  };
}

export function parseDeviceCode(text: string, now: Date): M365LoginStart | null {
  const uri = DEVICE_URI_PATTERN.exec(text)?.[0].replace(/[.,;)]+$/, '');
  const code = USER_CODE_PATTERN.exec(text)?.[1];
  if (!uri || !code) {
    return null;
  }
  return {
    verificationUri: uri,
    userCode: code,
    expiresAt: new Date(now.getTime() + DEVICE_CODE_LIFETIME_MS).toISOString(),
  };
}

export interface VerifyOutcome {
  loggedIn: boolean;
  account?: string;
  message?: string;
}

export function parseVerifyLogin(text: string): VerifyOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { loggedIn: false, message: text.trim() || undefined };
  }
  const parsed = verifyPayload.safeParse(payload);
  if (!parsed.success) {
    return { loggedIn: false, message: text.trim() || undefined };
  }
  const user = parsed.data.userData;
  const account = user?.userPrincipalName ?? user?.mail ?? user?.displayName ?? undefined;
  return {
    loggedIn: parsed.data.success === true,
    ...(account ? { account } : {}),
    ...(parsed.data.message ? { message: parsed.data.message } : {}),
  };
}

interface LoginSession {
  expiresAt: number;
}

export class M365LoginError extends Error {}

export class M365Login {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly host: Pick<McpHost, 'callTool'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(connectorId: string, force = false): Promise<M365LoginStart> {
    const reply = readToolText(await this.host.callTool(connectorId, M365_AUTH_TOOLS.login, { force }));
    if (reply.isError) {
      throw new M365LoginError(reply.text || 'Échec du lancement de la connexion');
    }
    const start = parseDeviceCode(reply.text, this.now());
    if (!start) {
      const verified = await this.verify(connectorId);
      throw new M365LoginError(
        verified.loggedIn
          ? `Déjà connecté${verified.account ? ` : ${verified.account}` : ''}`
          : reply.text || 'Code appareil introuvable dans la réponse du serveur',
      );
    }
    this.sessions.set(connectorId, { expiresAt: Date.parse(start.expiresAt) });
    return start;
  }

  async status(connectorId: string): Promise<M365LoginStatus> {
    let verified: VerifyOutcome;
    try {
      verified = await this.verify(connectorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const session = this.sessions.get(connectorId);
      if (session && session.expiresAt > this.now().getTime() && !ENTRA_ERROR_PATTERN.test(message)) {
        return { state: 'pending' };
      }
      this.sessions.delete(connectorId);
      return { state: 'failed', error: message };
    }
    if (verified.loggedIn) {
      this.sessions.delete(connectorId);
      return { state: 'done', ...(verified.account ? { account: verified.account } : {}) };
    }
    const session = this.sessions.get(connectorId);
    if (verified.message && ENTRA_ERROR_PATTERN.test(verified.message)) {
      this.sessions.delete(connectorId);
      return { state: 'failed', error: verified.message };
    }
    if (session && session.expiresAt <= this.now().getTime()) {
      this.sessions.delete(connectorId);
      return { state: 'failed', error: 'Le code a expiré, relancez la connexion' };
    }
    return { state: 'pending' };
  }

  private async verify(connectorId: string): Promise<VerifyOutcome> {
    const reply = readToolText(await this.host.callTool(connectorId, M365_AUTH_TOOLS.verifyLogin, {}));
    if (reply.isError) {
      throw new M365LoginError(reply.text || 'Vérification de la connexion impossible');
    }
    return parseVerifyLogin(reply.text);
  }
}
