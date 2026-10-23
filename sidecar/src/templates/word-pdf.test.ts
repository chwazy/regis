import { describe, expect, it } from 'vitest';
import { encodePowerShell, WORD_EXPORT_SCRIPT, wordPdfConverter } from './word-pdf';

describe('WORD_EXPORT_SCRIPT', () => {
  it('reads the paths from the environment instead of embedding them', () => {
    expect(WORD_EXPORT_SCRIPT).toContain('$env:REGIS_PDF_SOURCE');
    expect(WORD_EXPORT_SCRIPT).toContain('$env:REGIS_PDF_TARGET');
    expect(WORD_EXPORT_SCRIPT).toContain('ExportAsFixedFormat($env:REGIS_PDF_TARGET, 17)');
  });

  it('opens the document read-only and closes Word without saving', () => {
    expect(WORD_EXPORT_SCRIPT).toContain('Documents.Open($env:REGIS_PDF_SOURCE, $false, $true, $false)');
    expect(WORD_EXPORT_SCRIPT).toContain('$doc.Close(0)');
    expect(WORD_EXPORT_SCRIPT).toContain('$word.Quit()');
  });
});

describe('encodePowerShell', () => {
  it('encodes the script as base64 UTF-16LE', () => {
    expect(Buffer.from(encodePowerShell('Write-Output é'), 'base64').toString('utf16le')).toBe(
      'Write-Output é',
    );
  });
});

describe('wordPdfConverter.available', () => {
  it.skipIf(process.platform === 'win32')('is false outside Windows', async () => {
    expect(await wordPdfConverter.available()).toBe(false);
  });
});
