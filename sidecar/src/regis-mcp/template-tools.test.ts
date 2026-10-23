import { describe, expect, it } from 'vitest';
import { createTemplateTools } from './template-tools';
import { TemplateRenderError, type RenderInput } from '../templates/render';

describe('render_template tool', () => {
  it('renders for the calling job and returns the file ids', async () => {
    const calls: RenderInput[] = [];
    const tools = createTemplateTools({
      render: (input) => {
        calls.push(input);
        return Promise.resolve({ fileIds: ['F1'], missing: ['x'], warnings: [] });
      },
    });

    const result = await tools.render(
      { jobId: 'J7', agentId: 'a1' },
      { templateId: 'T1', entityId: 'E1', values: { 'client.nom': 'Atelier', n: 3 } },
    );

    expect(result).toEqual({ isError: false, payload: { fileIds: ['F1'], missing: ['x'], warnings: [] } });
    expect(calls).toEqual([
      { templateId: 'T1', entityId: 'E1', jobId: 'J7', values: { 'client.nom': 'Atelier', n: 3 } },
    ]);
  });

  it('refuses invalid parameters, unknown jobs and render errors', async () => {
    const tools = createTemplateTools({ render: () => Promise.reject(new TemplateRenderError('boom')) });

    expect((await tools.render({ jobId: 'J7', agentId: 'a' }, { templateId: 'T1' })).isError).toBe(true);
    expect((await tools.render({ jobId: '', agentId: 'a' }, { templateId: 'T1', values: {} })).isError).toBe(
      true,
    );
    expect(await tools.render({ jobId: 'J7', agentId: 'a' }, { templateId: 'T1', values: {} })).toEqual({
      isError: true,
      payload: { error: 'boom' },
    });
  });
});
