// PowerFill - Copyright (c) 2026 ChimCatz. MIT License.
//
// Values can contain {{tokens}} that are worked out at the moment of filling:
//   {{Company}}        the "Company" column of the current data row
//   {{ask:Company}}    asks the person for a value each time
//   {{my.email}}       a personal value from "My details"
//   {{today}} {{clear}}  handled later by the page engine, which knows the field's date format

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export const isTemplate = (v) => typeof v === 'string' && /\{\{[^{}]+\}\}/.test(v);
export const columnToken = (name) => `{{${name}}}`;
export const askToken = (label) => `{{ask:${label}}}`;
export const myToken = (key) => `{{my.${key}}}`;

function classify(body) {
  if (/^(today\b|clear$)/i.test(body)) return { type: 'builtin' };
  const ask = body.match(/^ask\s*:\s*(.+)$/i);
  if (ask) return { type: 'ask', name: ask[1].trim() };
  const my = body.match(/^my\.\s*(.+)$/i);
  if (my) return { type: 'my', name: my[1].trim() };
  return { type: 'column', name: body };
}

export function tokensIn(value) {
  return isTemplate(value) ? [...value.matchAll(TOKEN)].map((m) => classify(m[1])) : [];
}

const namesOf = (fields, type) => [...new Set(fields.flatMap((f) => tokensIn(f.value)).filter((t) => t.type === type).map((t) => t.name))];

// The questions to put to the person before filling, in sheet order, each asked once.
export const asksIn = (fields) => namesOf(fields, 'ask');
export const columnsIn = (fields) => namesOf(fields, 'column');

// True when the value is one data column and nothing else, i.e. the column is mapped to this field.
export const mappedColumn = (value) => {
  const tokens = tokensIn(value);
  return tokens.length === 1 && tokens[0].type === 'column' && value.trim() === value.match(TOKEN)[0] ? tokens[0].name : null;
};

// Works out a value for one fill. `row` maps column names to cells (null when the profile has no
// data rows), `vars` maps My details keys to values, `answers` maps asked labels to what was typed.
// Returns { value }, { empty: true } when it came out blank, or { error } when a token can't be resolved.
export function resolveValue(value, { row, vars, answers }) {
  if (!isTemplate(value)) return { value };
  let error = '';
  const lookup = (map, name) => {
    const key = Object.keys(map).find((k) => norm(k) === norm(name));
    return key === undefined ? undefined : map[key];
  };
  const text = value.replace(TOKEN, (whole, body) => {
    const token = classify(body);
    if (token.type === 'builtin') return whole;
    if (token.type === 'ask') return answers[token.name] ?? '';
    const found = token.type === 'my' ? lookup(vars, token.name) : row && lookup(row, token.name);
    if (found !== undefined && found !== null) return found;
    error ||= token.type === 'my' ? `“my.${token.name}” is not set in My details`
      : row ? `The data rows have no column called “${token.name}”`
      : `{{${token.name}}} needs data rows, and this profile has none`;
    return '';
  });
  if (error) return { error };
  return text.trim() === '' ? { empty: true } : { value: text };
}
