import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import type { FileEntry } from '@regis/shared';
import { VARIABLE_PATTERN } from './detect';
import { wordPdfConverter, type PdfConverter } from './word-pdf';

export interface RenderInput {
  templateId: string;
  values: Record<string, string | number>;
  entityId?: string;
  jobId: string;
  toPdf?: boolean;
}

export interface RenderResult {
  fileIds: string[];
  missing: string[];
  warnings: string[];
}

export class TemplateRenderError extends Error {}

export interface TemplateSource {
  name: string;
  filePath: string;
}

export interface RegisterGeneratedInput {
  relPath: string;
  templateId: string;
  jobId: string;
  entityId?: string;
}

export interface RenderDeps {
  getTemplateSource: (templateId: string) => Promise<TemplateSource>;
  generatedRoot: () => Promise<string>;
  registerGenerated: (input: RegisterGeneratedInput) => Promise<FileEntry>;
  pdf?: PdfConverter;
}

const SAFE_SEGMENT = /^[\w-]+$/;

let configured: RenderDeps | undefined;

export function configureRender(deps: RenderDeps): void {
  configured = deps;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function renderDocx(content: Buffer, lookup: (key: string) => string | undefined, missing: string[]): Buffer {
  const zip = new PizZip(content);
  const document = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    parser: (tag: string) => ({ get: () => lookup(tag.trim()) }),
    nullGetter: (part: { value?: string }) => {
      const key = (part.value ?? '').trim();
      if (key !== '' && !missing.includes(key)) {
        missing.push(key);
      }
      return '';
    },
  });
  try {
    document.render();
  } catch (error) {
    throw new TemplateRenderError(
      `Rendu du modèle impossible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return document.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderMarkdown(
  text: string,
  lookup: (key: string) => string | undefined,
  missing: string[],
): string {
  return text.replace(VARIABLE_PATTERN, (_match, key: string) => {
    const value = lookup(key);
    if (value === undefined) {
      if (!missing.includes(key)) {
        missing.push(key);
      }
      return '';
    }
    return value;
  });
}

async function uniqueName(directory: string, stem: string, extension: string): Promise<string> {
  let candidate = `${stem}${extension}`;
  for (let number = 2; await exists(join(directory, candidate)); number += 1) {
    candidate = `${stem} (${String(number)})${extension}`;
  }
  return candidate;
}

export async function renderTemplate(input: RenderInput): Promise<RenderResult> {
  const deps = configured;
  if (!deps) {
    throw new TemplateRenderError('Le rendu de modèles n’est pas configuré');
  }
  if (!SAFE_SEGMENT.test(input.jobId)) {
    throw new TemplateRenderError('Identifiant de job invalide');
  }
  const source = await deps.getTemplateSource(input.templateId);
  const extension = extname(source.filePath).toLowerCase();
  if (extension !== '.docx' && extension !== '.md') {
    throw new TemplateRenderError(`Format de modèle non rendu : ${extension || 'inconnu'}`);
  }
  const lookup = (key: string): string | undefined => {
    const value = Object.hasOwn(input.values, key) ? input.values[key] : undefined;
    return value === undefined ? undefined : String(value);
  };
  const missing: string[] = [];
  const content = await readFile(source.filePath);
  const rendered =
    extension === '.docx'
      ? renderDocx(content, lookup, missing)
      : Buffer.from(renderMarkdown(content.toString('utf8'), lookup, missing), 'utf8');

  const outDir = join(await deps.generatedRoot(), input.jobId);
  await mkdir(outDir, { recursive: true });
  const stem = basename(source.filePath, extname(source.filePath));
  const fileName = await uniqueName(outDir, stem, extension);
  await writeFile(join(outDir, fileName), rendered);
  const relPaths = [`${input.jobId}/${fileName}`];
  const warnings: string[] = [];

  if (input.toPdf) {
    const pdf = deps.pdf ?? wordPdfConverter;
    if (extension !== '.docx' || !(await pdf.available())) {
      warnings.push('Conversion PDF indisponible : le document est fourni au format d’origine seulement.');
    } else {
      const pdfName = `${basename(fileName, extension)}.pdf`;
      try {
        await pdf.convert(join(outDir, fileName), join(outDir, pdfName));
        relPaths.push(`${input.jobId}/${pdfName}`);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const fileIds: string[] = [];
  for (const relPath of relPaths) {
    const entry = await deps.registerGenerated({
      relPath,
      templateId: input.templateId,
      jobId: input.jobId,
      ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
    });
    fileIds.push(entry.id);
  }
  return { fileIds, missing, warnings };
}
