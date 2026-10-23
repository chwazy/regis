import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import PizZip from 'pizzip';

export type { TemplateVariable } from './sources';

export const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

const DOCX_PART_PATTERN = /^word\/(document|header\d*|footer\d*)\.xml$/;
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export class TemplateFormatError extends Error {}

export function extractVariableKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const key = match[1] ?? '';
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return XML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function paragraphsText(xml: string): string {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs
    .map((paragraph) =>
      [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((run) => decodeXml(run[1] ?? ''))
        .join(''),
    )
    .join('\n');
}

export async function docxText(filePath: string): Promise<string> {
  let zip: PizZip;
  try {
    zip = new PizZip(await readFile(filePath));
  } catch (error) {
    throw new TemplateFormatError(
      `Fichier DOCX illisible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parts = Object.keys(zip.files)
    .filter((name) => DOCX_PART_PATTERN.test(name))
    .sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)));
  if (!parts.includes('word/document.xml')) {
    throw new TemplateFormatError('Fichier DOCX sans word/document.xml');
  }
  return parts.map((name) => paragraphsText(zip.file(name)?.asText() ?? '')).join('\n');
}

export async function detectVariables(filePath: string): Promise<string[]> {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.docx') {
    return extractVariableKeys(await docxText(filePath));
  }
  if (extension === '.md' || extension === '.txt') {
    return extractVariableKeys(await readFile(filePath, 'utf8'));
  }
  return [];
}
