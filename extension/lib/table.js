// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Data rows: reading cells pasted from Excel / Google Sheets or loaded from a CSV file, matching
// the columns to fields, and checking the cells against what the page will accept.

import { norm, mappedColumn, columnToken, tokensIn } from './template.js';

const YES_NO = new Set(['true', 'yes', 'y', '1', 'on', 'x', 'check', 'checked', 'false', 'no', 'n', '0', 'off', 'uncheck', 'unchecked']);
const count = (text, ch) => text.split(ch).length - 1;
const letters = (i) => (i >= 26 ? letters(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

// Spreadsheets copy as tab-separated text; files are usually comma- or semicolon-separated.
// Quoted cells may contain the separator, line breaks, and doubled quotes.
export function parseTable(text, hasHeader = true) {
  text = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = text.split('\n', 1)[0];
  const separator = text.includes('\t') ? '\t' : count(firstLine, ';') > count(firstLine, ',') ? ';' : ',';
  const lines = [];
  let line = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === separator) { line.push(cell); cell = ''; }
    else if (ch === '\n') { line.push(cell); lines.push(line); line = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || line.length) { line.push(cell); lines.push(line); }

  const filled = lines.map((l) => l.map((c) => c.trim())).filter((l) => l.some(Boolean));
  if (!filled.length) throw new Error('There is nothing to read. Copy the cells in your spreadsheet and paste them here.');
  const width = Math.max(...filled.map((l) => l.length));
  const header = hasHeader ? filled.shift() : [];
  if (!filled.length) throw new Error('Only the header row was found. Copy the rows under it as well.');
  const seen = {};
  const columns = Array.from({ length: width }, (_, i) => {
    const name = header[i] || `Column ${letters(i)}`;
    seen[norm(name)] = (seen[norm(name)] || 0) + 1;
    return seen[norm(name)] > 1 ? `${name} (${seen[norm(name)]})` : name;
  });
  return { columns, rows: filled.map((l) => Array.from({ length: width }, (_, i) => l[i] ?? '')) };
}

export const rowObject = (data, index) => Object.fromEntries(data.columns.map((c, i) => [c, data.rows[index]?.[i] ?? '']));

// The same matching the page engine uses when it picks an option, so the check agrees with the fill.
export function findOption(options, wanted) {
  const w = norm(wanted);
  return options.find((o) => o.value === wanted) || options.find((o) => norm(o.text) === w) || options.find((o) => norm(o.value) === w) ||
    (w && options.find((o) => norm(o.text).startsWith(w))) || (w && options.find((o) => norm(o.text).includes(w))) || null;
}

const simplify = (s) => norm(s).replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Points each unused column at the field whose label matches its heading, if that field has no value yet.
// Returns how many columns were matched.
export function autoMatch(profile) {
  const { columns } = profile.data;
  const used = new Set(profile.fields.flatMap((f) => tokensIn(f.value)).filter((t) => t.type === 'column').map((t) => norm(t.name)));
  let matched = 0;
  for (const column of columns) {
    if (used.has(norm(column))) continue;
    const free = profile.fields.filter((f) => (Array.isArray(f.value) ? !f.value.length : !f.value));
    const key = simplify(column);
    // "Email" also matches "Email address", but only when exactly one field could be meant.
    const loose = key.length > 2 ? free.filter((f) => {
      const label = simplify(f.label);
      return label && (label.startsWith(key) || key.startsWith(label));
    }) : [];
    const field = free.find((f) => simplify(f.label) === key) || (loose.length === 1 ? loose[0] : null);
    if (!field) continue;
    field.value = columnToken(column);
    field.enabled = true;
    matched++;
  }
  return matched;
}

function cellProblem(field, cell) {
  if (cell === '') return field.required ? 'is empty, but the page requires it' : '';
  const parts = field.kind === 'multi' ? cell.split(/\s*[;|\n]\s*/).filter(Boolean) : [cell];
  if (field.options?.length && (field.kind === 'select' || field.kind === 'radio' || field.kind === 'multi')) {
    const unknown = parts.filter((p) => !findOption(field.options, p));
    return unknown.length ? `“${unknown.join('”, “')}” is not one of the page’s options` : '';
  }
  if (field.kind === 'check') return YES_NO.has(norm(cell)) ? '' : `“${cell}” should be yes or no`;
  if (field.inputType === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cell) ? '' : `“${cell}” is not an email address`;
  if (field.inputType === 'number') return isNaN(Number(cell)) ? `“${cell}” is not a number` : '';
  if (field.inputType === 'date') return isNaN(new Date(cell)) ? `“${cell}” is not a date` : '';
  return '';
}

// Looks at every cell that is mapped to a field and reports the ones the page would not accept.
// Returns [{ row, column, label, message }] with 0-based row and column numbers.
export function checkData(profile) {
  const { columns, rows } = profile.data || { columns: [], rows: [] };
  const problems = [];
  for (const field of profile.fields) {
    if (field.enabled === false) continue;
    const column = columns.findIndex((c) => norm(c) === norm(mappedColumn(field.value) ?? '\0'));
    if (column < 0) continue;
    rows.forEach((cells, row) => {
      const message = cellProblem(field, cells[column]);
      if (message) problems.push({ row, column, label: field.label || columns[column], message });
    });
  }
  return problems.sort((a, b) => a.row - b.row || a.column - b.column);
}
