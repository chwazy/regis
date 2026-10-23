import { describe, expect, it } from 'vitest';
import { detectVariables, docxText, extractVariableKeys } from './detect';
import { fixtureFile } from './test-support';

describe('detectVariables', () => {
  it('finds variables split over several runs of a DOCX', async () => {
    expect(await detectVariables(fixtureFile('offre.docx'))).toEqual(['client.nom', 'projet.budget_heures']);
  });

  it('returns a repeated Markdown variable once', async () => {
    expect(await detectVariables(fixtureFile('relance.md'))).toEqual([
      'contact.nom',
      'projet.reference',
      'client.nom',
    ]);
  });

  it('keeps the order of appearance and ignores spaces inside the braces', () => {
    expect(extractVariableKeys('{{ b.x }} {{a}} {{b.x}} {{ not valid }}')).toEqual(['b.x', 'a']);
  });

  it('reads the paragraph text of a DOCX', async () => {
    expect(await docxText(fixtureFile('offre.docx'))).toContain('Offre pour {{client.nom}}');
  });

  it('returns no variable for formats that are not rendered', async () => {
    expect(await detectVariables('devis.xlsx')).toEqual([]);
  });
});
