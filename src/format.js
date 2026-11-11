'use strict';
// Parse and serialize Databricks "source format" Python notebooks.
// Pure functions, no vscode imports, so they can be unit-tested on their own.
//
// Fidelity rule: every cell remembers its original text (`raw`) and the exact
// separator that preceded it (`sep`). On save, a cell whose content is
// unchanged is written back byte-for-byte; only edited cells are regenerated.

const HEADER = '# Databricks notebook source';
const CANON_SEP = '\n\n# COMMAND ----------\n\n';
const SEP_RE = /(^|\n\n?)# COMMAND ----------[ \t]*(\n\n?|$)/g;
const SEP_FULL_RE = /^\n{0,2}# COMMAND ----------[ \t]*\n{0,2}$/;
const HEADER_RE = /^# Databricks notebook source[ \t]*(\n|$)/;
const MAGIC_LINE_RE = /^# MAGIC( |$)/;
const TITLE_RE = /^# DBTITLE (.*)$/;

// %magic -> VS Code language id, for magics that switch the cell language.
const LANG_MAGICS = { sql: 'sql', scala: 'scala', r: 'r', sh: 'shellscript' };
const MAGIC_FOR_LANG = { sql: 'sql', scala: 'scala', r: 'r', shellscript: 'sh' };

/** raw cell text -> { kind, language, value, dbtitle?, magic? } */
function parseCell(raw) {
  let lines = raw.split('\n');
  const cell = { kind: 'code', language: 'python', value: '' };
  const title = TITLE_RE.exec(lines[0]);
  if (title) {
    cell.dbtitle = title[1];
    lines = lines.slice(1);
  }
  cell.value = lines.join('\n');
  if (!lines.length || !lines.every((l) => MAGIC_LINE_RE.test(l))) return cell;

  const body = lines.map((l) => l.slice(8)); // strip "# MAGIC " (or bare "# MAGIC")
  const m = /^%([\w-]+)(?:[ \t]+(.*))?$/.exec(body[0]);
  const magic = m && m[1];
  if (magic === 'md' || magic === 'md-sandbox' || LANG_MAGICS[magic]) {
    cell.value = (m[2] ? [m[2]] : []).concat(body.slice(1)).join('\n');
    if (LANG_MAGICS[magic]) {
      cell.language = LANG_MAGICS[magic];
    } else {
      cell.kind = 'markdown';
      cell.language = 'markdown';
      if (magic !== 'md') cell.magic = magic;
    }
  } else {
    // %run, %pip, %fs, ...: keep as a Python cell that shows the magic line.
    cell.value = body.join('\n');
  }
  return cell;
}

function magicLines(lines) {
  return lines.map((l) => (l === '' ? '# MAGIC' : '# MAGIC ' + l));
}

/** { kind, language, value, dbtitle?, magic? } -> canonical cell text */
function renderCell(cell) {
  const lines = cell.value.split('\n');
  let out;
  if (cell.kind === 'markdown') {
    out = magicLines(['%' + (cell.magic === 'md-sandbox' ? 'md-sandbox' : 'md'), ...lines]);
  } else if (MAGIC_FOR_LANG[cell.language]) {
    out = magicLines(['%' + MAGIC_FOR_LANG[cell.language], ...lines]);
  } else if (/^%[\w-]/.test(cell.value)) {
    out = magicLines(lines);
  } else {
    out = lines;
  }
  if (cell.dbtitle !== undefined) out = ['# DBTITLE ' + cell.dbtitle, ...out];
  return out.join('\n');
}

/** file text -> { eol, header, trailer, cells: [{ kind, language, value, raw, sep?, ... }] } */
function parseNotebook(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (eol === '\r\n') text = text.replace(/\r\n/g, '\n');

  const h = HEADER_RE.exec(text);
  if (!h) {
    // Not a Databricks notebook: show the whole file as one Python cell.
    return { eol, header: '', trailer: '', cells: [{ ...parseCell(text), raw: text }] };
  }
  const header = h[0];
  let body = text.slice(header.length);
  let trailer = '';
  if (body.endsWith('\n')) {
    trailer = '\n';
    body = body.slice(0, -1);
  }

  const cells = [];
  let pos = 0;
  let sep;
  SEP_RE.lastIndex = 0;
  for (let m; (m = SEP_RE.exec(body)); ) {
    const raw = body.slice(pos, m.index);
    cells.push({ ...parseCell(raw), raw, sep });
    sep = m[0];
    pos = m.index + m[0].length;
  }
  const raw = body.slice(pos);
  cells.push({ ...parseCell(raw), raw, sep });
  return { eol, header, trailer, cells };
}

function cellText(cell) {
  const c = { ...cell, value: cell.value.replace(/\r\n/g, '\n') };
  if (typeof c.raw === 'string') {
    const p = parseCell(c.raw);
    const same =
      p.kind === c.kind &&
      p.language === c.language &&
      p.value === c.value &&
      p.dbtitle === c.dbtitle &&
      p.magic === c.magic;
    if (same) return c.raw;
  }
  return renderCell(c);
}

/** inverse of parseNotebook; cells without raw/sep get canonical text */
function serializeNotebook(nb) {
  const texts = nb.cells.map(cellText);
  let out = typeof nb.header === 'string' ? nb.header : HEADER + '\n';
  if (out === '' && texts.length > 1) out = HEADER + '\n';
  if (out && !out.endsWith('\n') && (texts.length > 1 || texts[0])) out += '\n';

  texts.forEach((text, i) => {
    if (i > 0) {
      const s = nb.cells[i].sep;
      // Reuse the original separator unless it would glue onto neighbouring text
      // (a separator at the very start or end of a file can lack a newline).
      const fits =
        typeof s === 'string' &&
        SEP_FULL_RE.test(s) &&
        (s.startsWith('\n') || (i === 1 && texts[0] === '')) &&
        (s.endsWith('\n') || (i === texts.length - 1 && text === ''));
      out += fits ? s : CANON_SEP;
    }
    out += text;
  });
  out += typeof nb.trailer === 'string' ? nb.trailer : '\n';
  return nb.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

module.exports = { HEADER, CANON_SEP, parseCell, renderCell, parseNotebook, serializeNotebook };
