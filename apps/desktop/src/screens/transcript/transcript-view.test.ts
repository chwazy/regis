import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@regis/shared';
import {
  appendSegment,
  backlogLabel,
  buildTurns,
  clockLabel,
  estimatedAudioBytes,
  formatBytes,
  levelFraction,
  originEntityId,
  speakerLabel,
  transcriptLinkState,
} from './transcript-view';

function segment(source: 'mic' | 'system', startMs: number, endMs: number, text: string): TranscriptSegment {
  return { source, startMs, endMs, text };
}

describe('labels', () => {
  it('names the two channels', () => {
    expect(speakerLabel('mic')).toBe('Moi');
    expect(speakerLabel('system')).toBe('Participants');
  });

  it('formats clock labels as hh:mm:ss', () => {
    expect(clockLabel(0)).toBe('00:00:00');
    expect(clockLabel(3_725_000)).toBe('01:02:05');
  });

  it('shows the backlog only when blocks are waiting', () => {
    expect(backlogLabel(0)).toBeNull();
    expect(backlogLabel(1)).toBe('1 bloc en attente');
    expect(backlogLabel(3)).toBe('3 blocs en attente');
  });
});

describe('appendSegment', () => {
  it('adds a live segment in start order and ignores a duplicate', () => {
    const first = segment('mic', 0, 1000, 'Bonjour');
    const late = segment('system', 4000, 5000, 'Salut');
    const middle = segment('mic', 2000, 3000, 'à tous');

    const list = appendSegment(appendSegment([first], late), middle);

    expect(list.map((item) => item.startMs)).toEqual([0, 2000, 4000]);
    expect(appendSegment(list, { ...middle })).toBe(list);
  });
});

describe('buildTurns', () => {
  it('merges close segments of one channel and splits on a channel change', () => {
    const turns = buildTurns([
      segment('system', 4000, 5000, 'Bonjour Dylan'),
      segment('mic', 1500, 2500, 'à tous'),
      segment('mic', 0, 1000, 'Bonjour'),
    ]);

    expect(turns).toEqual([
      { source: 'mic', startMs: 0, endMs: 2500, text: 'Bonjour à tous' },
      { source: 'system', startMs: 4000, endMs: 5000, text: 'Bonjour Dylan' },
    ]);
  });

  it('starts a new turn after a pause of two seconds', () => {
    expect(buildTurns([segment('mic', 0, 1000, 'Un'), segment('mic', 3000, 4000, 'Deux')])).toHaveLength(2);
  });
});

describe('audio size and levels', () => {
  it('estimates about 115 MB per hour and per source', () => {
    const oneSource = estimatedAudioBytes(3_600_000, 'mic');
    expect(formatBytes(oneSource)).toBe('109.9 Mo');
    expect(estimatedAudioBytes(3_600_000, 'both')).toBe(oneSource * 2);
    expect(formatBytes(512)).toBe('1 Ko');
  });

  it('maps an RMS level to a gauge fraction', () => {
    expect(levelFraction(null)).toBe(0);
    expect(levelFraction(0.1)).toBeCloseTo(0.5);
    expect(levelFraction(0.9)).toBe(1);
  });
});

describe('origin entity', () => {
  it('reads the entity the user came from, and nothing else', () => {
    expect(originEntityId(transcriptLinkState('E1'))).toBe('E1');
    expect(originEntityId(null)).toBeNull();
    expect(originEntityId({ fromEntityId: 3 })).toBeNull();
    expect(originEntityId({ fromEntityId: '' })).toBeNull();
  });
});
