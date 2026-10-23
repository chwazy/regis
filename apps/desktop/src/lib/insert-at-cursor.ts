export interface InsertResult {
  value: string;
  cursor: number;
}

export function insertAtCursor(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  inserted: string,
): InsertResult {
  const text = inserted.trim();
  if (text === '') {
    return { value, cursor: selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const end = Math.min(value.length, Math.max(selectionStart, selectionEnd, start));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  return {
    value: `${before}${lead}${text}${trail}${after}`,
    cursor: before.length + lead.length + text.length,
  };
}
