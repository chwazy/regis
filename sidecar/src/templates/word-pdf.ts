import { spawn } from 'node:child_process';

export interface PdfConverter {
  available: () => Promise<boolean>;
  convert: (source: string, target: string) => Promise<void>;
}

export class PdfConversionError extends Error {}

const DETECT_TIMEOUT_MS = 10_000;
const CONVERT_TIMEOUT_MS = 120_000;
const WD_EXPORT_FORMAT_PDF = 17;
const WD_DO_NOT_SAVE_CHANGES = 0;

export const WORD_EXPORT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$word = New-Object -ComObject Word.Application',
  'try {',
  '  $word.Visible = $false',
  '  $word.DisplayAlerts = 0',
  '  $doc = $word.Documents.Open($env:REGIS_PDF_SOURCE, $false, $true, $false)',
  `  try { $doc.ExportAsFixedFormat($env:REGIS_PDF_TARGET, ${String(WD_EXPORT_FORMAT_PDF)}) }`,
  `  finally { $doc.Close(${String(WD_DO_NOT_SAVE_CHANGES)}) }`,
  '} finally {',
  '  $word.Quit()',
  '  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)',
  '}',
].join('\n');

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, env });
    const timer = setTimeout(() => {
      child.kill();
      reject(new PdfConversionError('Conversion PDF trop longue'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function wordInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    return (await run('reg.exe', ['query', 'HKCR\\Word.Application\\CurVer'], DETECT_TIMEOUT_MS)) === 0;
  } catch {
    return false;
  }
}

async function convertWithWord(source: string, target: string): Promise<void> {
  let code: number | null;
  try {
    code = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(WORD_EXPORT_SCRIPT),
      ],
      CONVERT_TIMEOUT_MS,
      { ...process.env, REGIS_PDF_SOURCE: source, REGIS_PDF_TARGET: target },
    );
  } catch (error) {
    if (error instanceof PdfConversionError) {
      throw error;
    }
    throw new PdfConversionError(
      `Conversion PDF impossible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (code !== 0) {
    throw new PdfConversionError(`Conversion PDF par Word en échec (code ${String(code)})`);
  }
}

export const wordPdfConverter: PdfConverter = {
  available: wordInstalled,
  convert: convertWithWord,
};
