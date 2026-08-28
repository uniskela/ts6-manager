/** Helpers for inserting TS6 Markdown / BBCode into a textarea at the cursor. */

export interface TextSelection {
  start: number;
  end: number;
}

export interface TextEditResult {
  value: string;
  selection: TextSelection;
}

export function wrapSelection(
  value: string,
  selection: TextSelection,
  before: string,
  after: string,
  placeholder = 'text',
): TextEditResult {
  const { start, end } = selection;
  const selected = value.slice(start, end);
  const inner = selected || placeholder;
  const newValue = value.slice(0, start) + before + inner + after + value.slice(end);
  const newStart = start + before.length;
  const newEnd = newStart + inner.length;
  return { value: newValue, selection: { start: newStart, end: newEnd } };
}

export function prefixLines(
  value: string,
  selection: TextSelection,
  prefix: string,
  placeholder = 'item',
): TextEditResult {
  const { start, end } = selection;
  const selected = value.slice(start, end);
  const block = selected || placeholder;
  const lines = block.split('\n');
  const prefixed = lines.map((line) => (line ? `${prefix}${line}` : prefix.trimEnd())).join('\n');
  const newValue = value.slice(0, start) + prefixed + value.slice(end);
  return {
    value: newValue,
    selection: { start, end: start + prefixed.length },
  };
}

export function insertAtCursor(
  value: string,
  selection: TextSelection,
  insert: string,
  selectInserted = false,
): TextEditResult {
  const { start, end } = selection;
  const newValue = value.slice(0, start) + insert + value.slice(end);
  const newEnd = start + insert.length;
  return {
    value: newValue,
    selection: selectInserted
      ? { start, end: newEnd }
      : { start: newEnd, end: newEnd },
  };
}

export function insertBlock(
  value: string,
  selection: TextSelection,
  block: string,
): TextEditResult {
  const { start, end } = selection;
  const needsLeadingNewline = start > 0 && value[start - 1] !== '\n';
  const needsTrailingNewline = end < value.length && value[end] !== '\n';
  const padded =
    (needsLeadingNewline ? '\n' : '') + block + (needsTrailingNewline ? '\n' : '');
  const insertStart = start + (needsLeadingNewline ? 1 : 0);
  const newValue = value.slice(0, start) + padded + value.slice(end);
  const insertEnd = insertStart + block.length;
  return {
    value: newValue,
    selection: { start: insertStart, end: insertEnd },
  };
}
