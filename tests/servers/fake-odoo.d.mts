export const FAKE_UID: number;
export const FAKE_API_KEY: string;
export const FAKE_DB: string;
export const FAKE_LOGIN: string;

export interface FakeOdooCall {
  service: string;
  method: string;
  model?: string;
  odooMethod?: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  login?: string;
}

export interface FakeOdoo {
  url: string;
  journal: FakeOdooCall[];
  close: () => Promise<void>;
}

export function startFakeOdoo(options?: { missingModels?: string[] }): Promise<FakeOdoo>;
