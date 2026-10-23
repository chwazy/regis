import { describe, expect, it } from 'vitest';
import { classifyTool } from './classify';

describe('classifyTool', () => {
  it('reads from the name prefix', () => {
    expect(classifyTool({ name: 'search_records' })).toBe('read');
    expect(classifyTool({ name: 'list-mail-messages' })).toBe('read');
    expect(classifyTool({ name: 'getUser' })).toBe('read');
  });

  it('treats everything else as write', () => {
    expect(classifyTool({ name: 'create_record' })).toBe('write');
    expect(classifyTool({ name: 'send-mail' })).toBe('write');
  });

  it('only trusts the first name segment', () => {
    expect(classifyTool({ name: 'delete_search' })).toBe('write');
    expect(classifyTool({ name: 'create_list' })).toBe('write');
    expect(classifyTool({ name: 'update_query' })).toBe('write');
    expect(classifyTool({ name: 'list_messages' })).toBe('read');
    expect(classifyTool({ name: 'get-mail-message' })).toBe('read');
  });

  it('prefers the readOnlyHint annotation', () => {
    expect(classifyTool({ name: 'x', annotations: { readOnlyHint: true } })).toBe('read');
    expect(classifyTool({ name: 'get_x', annotations: { readOnlyHint: false } })).toBe('write');
  });

  it('lets a manual override win', () => {
    expect(classifyTool({ name: 'get_x' }, 'write')).toBe('write');
    expect(classifyTool({ name: 'create_x', annotations: { readOnlyHint: false } }, 'read')).toBe('read');
  });
});
