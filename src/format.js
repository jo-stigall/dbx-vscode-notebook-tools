'use strict';
/**
 * Convert a Databricks notebook file (.py) to notebook cells, and back.
 *
 * Databricks saves a Python notebook as a normal .py file with special comments:
 *
 *     # Databricks notebook source      <- line 1 tells you that the file is a notebook
 *     # MAGIC %md                       <- "# MAGIC" lines hold content that is not Python
 *     # MAGIC # Sales report
 *
 *     # COMMAND ----------              <- this line separates two cells
 *
 *     # DBTITLE 1,Load the data         <- optional title of the cell
 *     df = spark.table("sales")
 *
 * parseNotebook() reads this text and returns a list of cells.
 * serializeNotebook() takes a list of cells and returns this text.
 *
 * The two functions keep your git diff small. parseNotebook() stores the
 * original text of each cell in `raw`. serializeNotebook() writes `raw` again
 * if you did not change the cell. It writes new text only for a cell that you
 * changed or added.
 *
 * This file does not import VS Code. You can test it without VS Code.
 */

/**
 * One notebook cell.
 *
 * @typedef {object} Cell
 * @property {'code'|'markdown'} kind  A markdown cell shows text. A code cell runs.
 * @property {string} language  VS Code language name: 'python', 'sql', 'scala', 'r', 'shellscript' or 'markdown'.
 * @property {string} value  The text that you see in the cell, without "# MAGIC" prefixes.
 * @property {string} [dbtitle]  The text after "# DBTITLE ". Example: '1,Load the data'.
 * @property {string} [magic]  Set to 'md-sandbox' when the cell uses %md-sandbox and not %md.
 * @property {string} [raw]  The original text of the cell in the file. Only cells from a file have it.
 * @property {string} [sep]  The original separator before the cell. The first cell does not have it.
 */

/**
 * One notebook file.
 *
 * @typedef {object} Notebook
 * @property {Cell[]} cells
 * @property {'\n'|'\r\n'} [eol]  The line ending of the file. Windows files use '\r\n'.
 * @property {string} [header]  The first line and its line ending. Empty for a file that is not a notebook.
 * @property {string} [trailer]  The line ending after the last cell. Empty if the file has none.
 * @property {boolean} [bom]  true if the file starts with a byte-order mark (the character U+FEFF). Some Windows editors write it.
 */

/** The first line of each Databricks notebook file. */
const HEADER = '# Databricks notebook source';

/** The separator that Databricks writes between two cells. */
const CANON_SEP = '\n\n# COMMAND ----------\n\n';

/** Finds a separator in a file. It accepts zero, one or two empty lines on each side. */
const SEP_RE = /(^|\n\n?)# COMMAND ----------[ \t]*(\n\n?|$)/g;

/** Checks that a stored separator is a separator and nothing else. */
const SEP_FULL_RE = /^\n{0,2}# COMMAND ----------[ \t]*\n{0,2}$/;

/** Finds the header line at the start of a file. */
const HEADER_RE = /^# Databricks notebook source[ \t]*(\n|$)/;

/**
 * Tell if a text starts with the header line of a Databricks notebook.
 *
 * @example
 * hasHeader('# Databricks notebook source\nx = 1')   // true
 * hasHeader('# Databricks notebook sources')         // false: the line has more text
 * hasHeader('x = 1')                                 // false
 *
 * @param {string} text  The text of a file, or its first line.
 * @returns {boolean}
 */
const hasHeader = (text) => HEADER_RE.test(text.split(/\r?\n/, 1)[0]);

/** Matches a line that starts with "# MAGIC". */
const MAGIC_LINE_RE = /^# MAGIC( |$)/;

/** Matches a cell title line. Example: "# DBTITLE 1,Load the data". */
const TITLE_RE = /^# DBTITLE (.*)$/;

/** Magic command -> VS Code language name. These magic commands change the language of a cell. */
const LANG_MAGICS = { sql: 'sql', scala: 'scala', r: 'r', sh: 'shellscript' };

/** VS Code language name -> magic command. The opposite of LANG_MAGICS. */
const MAGIC_FOR_LANG = { sql: 'sql', scala: 'scala', r: 'r', shellscript: 'sh' };

/**
 * Convert the text of one cell in the file to a cell.
 *
 * The function removes the "# MAGIC" prefix from each line. It uses the magic
 * command on the first line to find the cell type:
 *
 * - `%md` gives a markdown cell.
 * - `%sql`, `%scala`, `%r` and `%sh` give a code cell in that language.
 * - Other magic commands (`%run`, `%pip`, ...) give a Python cell. The cell
 *   keeps the magic command in its text.
 * - Text without "# MAGIC" gives a Python cell.
 *
 * @example
 * parseCell('# MAGIC %sql\n# MAGIC select 1')
 * // { kind: 'code', language: 'sql', value: 'select 1' }
 *
 * parseCell('# MAGIC %run ./setup')
 * // { kind: 'code', language: 'python', value: '%run ./setup' }
 *
 * parseCell('# DBTITLE 1,Totals\nprint(total)')
 * // { kind: 'code', language: 'python', value: 'print(total)', dbtitle: '1,Totals' }
 *
 * @param {string} raw  The text between two separators. Line endings must be '\n'.
 * @returns {Cell}  A cell without `raw` and `sep`.
 */
function parseCell(raw) {
  let lines = raw.split('\n');
  const cell = { kind: 'code', language: 'python', value: '' };
  const title = TITLE_RE.exec(lines[0]);
  if (title) {
    cell.dbtitle = title[1];
    lines = lines.slice(1);
  }
  cell.value = lines.join('\n');
  // A cell is a magic cell only if each line starts with "# MAGIC".
  if (!lines.length || !lines.every((l) => MAGIC_LINE_RE.test(l))) return cell;

  const body = lines.map((l) => l.slice(8)); // remove "# MAGIC " (8 characters)
  const m = /^%([\w-]+)(?:[ \t]+(.*))?$/.exec(body[0]);
  const magic = m && m[1];
  if (magic === 'md' || magic === 'md-sandbox' || LANG_MAGICS[magic]) {
    // "%sql select 1" on one line is the same as "%sql" and then "select 1".
    cell.value = (m[2] ? [m[2]] : []).concat(body.slice(1)).join('\n');
    if (LANG_MAGICS[magic]) {
      cell.language = LANG_MAGICS[magic];
    } else {
      cell.kind = 'markdown';
      cell.language = 'markdown';
      if (magic !== 'md') cell.magic = magic;
    }
  } else {
    cell.value = body.join('\n');
  }
  return cell;
}

/**
 * Add the "# MAGIC" prefix to each line.
 *
 * An empty line becomes "# MAGIC" without a space at the end. Databricks
 * writes empty lines in the same way.
 *
 * @example
 * magicLines(['%md', '# Title', ''])
 * // ['# MAGIC %md', '# MAGIC # Title', '# MAGIC']
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function magicLines(lines) {
  return lines.map((l) => (l === '' ? '# MAGIC' : '# MAGIC ' + l));
}

/**
 * Convert a cell to the text that Databricks writes for that cell.
 *
 * This function is the opposite of parseCell(). It ignores `raw` and `sep`.
 *
 * @example
 * renderCell({ kind: 'code', language: 'sql', value: 'select 1' })
 * // '# MAGIC %sql\n# MAGIC select 1'
 *
 * renderCell({ kind: 'markdown', language: 'markdown', value: '# Title' })
 * // '# MAGIC %md\n# MAGIC # Title'
 *
 * renderCell({ kind: 'code', language: 'python', value: 'x = 1' })
 * // 'x = 1'
 *
 * @param {Cell} cell
 * @returns {string}
 */
function renderCell(cell) {
  const lines = cell.value.split('\n');
  let out;
  if (cell.kind === 'markdown') {
    out = magicLines(['%' + (cell.magic === 'md-sandbox' ? 'md-sandbox' : 'md'), ...lines]);
  } else if (MAGIC_FOR_LANG[cell.language]) {
    out = magicLines(['%' + MAGIC_FOR_LANG[cell.language], ...lines]);
  } else if (/^%[\w-]/.test(cell.value)) {
    // A Python cell that starts with a magic command, for example "%run ./setup".
    out = magicLines(lines);
  } else {
    out = lines;
  }
  if (cell.dbtitle !== undefined) out = ['# DBTITLE ' + cell.dbtitle, ...out];
  return out.join('\n');
}

/**
 * Convert the text of a .py file to a notebook.
 *
 * The function splits the text at each "# COMMAND ----------" line. Each cell
 * keeps its original text in `raw` and the separator before it in `sep`.
 * serializeNotebook() uses `raw` and `sep` to write the same bytes again.
 *
 * A file that does not start with the Databricks header gives one Python cell
 * that contains all of the file.
 *
 * @example
 * const nb = parseNotebook('# Databricks notebook source\nx = 1\n\n# COMMAND ----------\n\ny = 2\n');
 * nb.cells.map((c) => c.value)   // ['x = 1', 'y = 2']
 * nb.header                      // '# Databricks notebook source\n'
 * nb.cells[1].sep                // '\n\n# COMMAND ----------\n\n'
 *
 * @param {string} text  The full text of the file.
 * @returns {Notebook}
 */
function parseNotebook(text) {
  // Remember a byte-order mark, so that serializeNotebook() can write it again. It is not a part of the first line.
  const mark = text.startsWith('\uFEFF') ? { bom: true } : {};
  if (mark.bom) text = text.slice(1);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (eol === '\r\n') text = text.replace(/\r\n/g, '\n');

  const h = HEADER_RE.exec(text);
  if (!h) {
    return { eol, header: '', trailer: '', cells: [{ ...parseCell(text), raw: text }], ...mark };
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
  return { eol, header, trailer, cells, ...mark };
}

/**
 * Get the text to write to the file for one cell.
 *
 * The function returns the original text (`raw`) if you did not change the
 * cell. If you changed the text, the language, the type or the title, the
 * function returns new text from renderCell().
 *
 * @example
 * // The file has "%sql select 1" on one line. Databricks usually writes two lines.
 * const cell = { ...parseCell('# MAGIC %sql select 1'), raw: '# MAGIC %sql select 1' };
 * cellText(cell)                          // '# MAGIC %sql select 1'  (not changed)
 * cellText({ ...cell, value: 'select 2' }) // '# MAGIC %sql\n# MAGIC select 2'  (changed)
 *
 * @param {Cell} cell
 * @returns {string}
 */
function cellText(cell) {
  // VS Code on Windows can give cell text with '\r\n' line endings.
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

/**
 * Convert a notebook to the text of a .py file.
 *
 * This function is the opposite of parseNotebook(). If you parse a file and
 * serialize the result without a change, you get the same text.
 *
 * The function writes these parts in sequence:
 *
 * 1. The header line. A notebook without a stored header gets the Databricks
 *    header. A file that is not a notebook gets the header when you add a
 *    second cell.
 * 2. Each cell, from cellText().
 * 3. A separator before each cell after the first. The function uses the
 *    original separator of the cell. It uses the Databricks separator for a
 *    new cell.
 * 4. The line ending at the end of the file.
 *
 * @example
 * const nb = parseNotebook(text);
 * nb.cells[0].value = 'x = 2';      // change one cell
 * serializeNotebook(nb);            // same text as before, but with 'x = 2' in the first cell
 *
 * @param {Notebook} nb
 * @returns {string}  The full text of the file.
 */
function serializeNotebook(nb) {
  const texts = nb.cells.map(cellText);
  let out = typeof nb.header === 'string' ? nb.header : HEADER + '\n';
  if (out === '' && texts.length > 1) out = HEADER + '\n';
  if (out && !out.endsWith('\n') && (texts.length > 1 || texts[0])) out += '\n';

  texts.forEach((text, i) => {
    if (i > 0) {
      const s = nb.cells[i].sep;
      // A separator at the start or the end of a file can have no line ending
      // on one side. Use that separator only in the same position. In other
      // positions it would join two lines.
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
  if (nb.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return nb.bom ? '\uFEFF' + out : out;
}

module.exports = { HEADER, CANON_SEP, hasHeader, parseCell, renderCell, parseNotebook, serializeNotebook };
