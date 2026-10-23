import { describe, expect, it } from 'vitest';
import type { Recording } from '@regis/shared';
import {
  CONSENT_TEXT,
  buildStartInput,
  canConfirmConsent,
  elapsedSince,
  formatDuration,
  isSessionLive,
  startAndJoin,
  type Invoke,
} from './recording';

const RECORDING: Recording = {
  id: 'r1',
  title: 'Point client',
  status: 'recording',
  sources: 'both',
  startedAt: '2026-10-22T08:00:00.000Z',
  endedAt: null,
  durationMs: null,
  consentAt: '2026-10-22T08:00:00.000Z',
  sttModel: 'fake',
  audioAvailable: true,
  error: null,
};

describe('consent', () => {
  it('keeps the start button disabled until the box is ticked', () => {
    expect(canConfirmConsent(false)).toBe(false);
    expect(canConfirmConsent(true)).toBe(true);
    expect(CONSENT_TEXT).toContain('ils acceptent');
  });
});

describe('formatting', () => {
  it('formats durations below and above one hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('measures the time elapsed since the start, never negative', () => {
    const start = Date.parse(RECORDING.startedAt);
    expect(elapsedSince(RECORDING.startedAt, start + 4_000)).toBe(4_000);
    expect(elapsedSince(RECORDING.startedAt, start - 4_000)).toBe(0);
    expect(elapsedSince('nope', start)).toBe(0);
  });

  it('knows which sessions are still live', () => {
    expect(isSessionLive(RECORDING)).toBe(true);
    expect(isSessionLive({ ...RECORDING, status: 'finalizing' })).toBe(true);
    expect(isSessionLive({ ...RECORDING, status: 'done' })).toBe(false);
    expect(isSessionLive(null)).toBe(false);
  });
});

describe('buildStartInput', () => {
  it('sends no entity and no title when the form leaves them empty', () => {
    expect(buildStartInput({ title: '  ', sources: 'mic', entityId: '' }, null, CONSENT_TEXT)).toEqual({
      title: null,
      sources: 'mic',
      eventItemId: null,
      entityId: null,
      consentConfirmed: true,
      consentText: CONSENT_TEXT,
    });
  });

  it('sends the chosen entity and the trimmed title', () => {
    const input = buildStartInput(
      { title: ' Atelier ', sources: 'both', entityId: 'E1' },
      null,
      CONSENT_TEXT,
    );
    expect(input).toMatchObject({ title: 'Atelier', entityId: 'E1', sources: 'both' });
  });
});

describe('startAndJoin', () => {
  function fakeInvoke(openFails: boolean) {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const invoke: Invoke = <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'open_meeting' && openFails) {
        return Promise.reject(new Error('Ouverture impossible'));
      }
      return Promise.resolve((cmd === 'recording_start' ? RECORDING : null) as T);
    };
    return { invoke, calls };
  }

  it('starts a both-sources recording tied to the event, then opens the meeting', async () => {
    const { invoke, calls } = fakeInvoke(false);

    const result = await startAndJoin(invoke, { id: 'ev1', title: 'Point projet' }, CONSENT_TEXT);

    expect(calls.map((call) => call.cmd)).toEqual(['recording_start', 'open_meeting']);
    expect(calls[0]?.args).toEqual({
      input: {
        title: 'Point projet',
        sources: 'both',
        eventItemId: 'ev1',
        entityId: null,
        consentConfirmed: true,
        consentText: CONSENT_TEXT,
      },
    });
    expect(calls[1]?.args).toEqual({ itemId: 'ev1' });
    expect(result.openError).toBeNull();
  });

  it('keeps the recording and reports the error when the meeting cannot be opened', async () => {
    const { invoke } = fakeInvoke(true);

    const result = await startAndJoin(invoke, { id: 'ev1', title: 'Point projet' }, CONSENT_TEXT);

    expect(result.recording.id).toBe('r1');
    expect(result.openError).toBe('Ouverture impossible');
  });

  it('does not open the meeting when the recording cannot start', async () => {
    const calls: string[] = [];
    const invoke: Invoke = <T>(cmd: string) => {
      calls.push(cmd);
      return Promise.reject(new Error('consentement non confirmé')) as Promise<T>;
    };

    await expect(startAndJoin(invoke, { id: 'ev1', title: 'x' }, CONSENT_TEXT)).rejects.toThrow();
    expect(calls).toEqual(['recording_start']);
  });
});
