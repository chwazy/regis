import type { FileEntry, Template } from '@regis/shared';
import type { RegisterGeneratedInput } from './render';
import type { TemplateVariable } from './sources';

export interface TemplatePatch {
  variablesJson?: TemplateVariable[];
  version?: number;
}

export interface TemplateStore {
  getTemplate: (id: string) => Promise<Template>;
  updateTemplate: (id: string, patch: TemplatePatch) => Promise<Template>;
  getFile: (id: string) => Promise<FileEntry>;
  registerGenerated: (input: RegisterGeneratedInput) => Promise<FileEntry>;
}

export type HostCall = <T>(method: string, params?: unknown) => Promise<T>;

export function createHostTemplateStore(call: HostCall): TemplateStore {
  return {
    getTemplate: (id) => call<Template>('store.templates.get', { id }),
    updateTemplate: (id, patch) => call<Template>('store.templates.update', { id, patch }),
    getFile: (id) => call<FileEntry>('store.files.get', { id }),
    registerGenerated: (input) => call<FileEntry>('store.files.registerGenerated', input),
  };
}
