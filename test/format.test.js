'use strict';
/**
 * Tests for src/format.js: convert a .py file to cells, and back.
 *
 * The most important tests make sure that a file does not change when you
 * open it and save it without an edit.
 *
 * You do not need Node.js. VS Code contains a JavaScript runtime. Run:
 *
 *     ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/format.test.js
 *
 * The script prints the number of tests that passed, for example "14 passed". It prints each failure
 * and exits with code 1 if a test fails.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseNotebook, serializeNotebook, parseCell, renderCell, hasHeader } = require('../src/format');

let passed = 0;

/**
 * Run one test. Print the error if the test fails, then continue with the next test.
 *
 * @param {string} name  What the test checks. The script prints it if the test fails.
 * @param {() => void} fn  The test. It throws an error if a check fails.
 */
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

/** Do what "open the file, then save it" does: convert the text to cells, and back to text. */
const roundTrip = (text) => serializeNotebook(parseNotebook(text));

/** A notebook file in the format that Databricks writes. It has five cells. */
const CANONICAL = [
  '# Databricks notebook source',
  '# MAGIC %md',
  '# MAGIC # Title',
  '# MAGIC',
  '# MAGIC Some text',
  '',
  '# COMMAND ----------',
  '',
  'import os',
  '',
  'x = 1',
  '',
  '# COMMAND ----------',
  '',
  '# MAGIC %sql',
  '# MAGIC select 1 as id',
  '',
  '# COMMAND ----------',
  '',
  '# DBTITLE 1,Load helpers',
  '# MAGIC %run ./helpers/setup',
  '',
  '# COMMAND ----------',
  '',
  '# MAGIC %pip install foo',
  '',
].join('\n');

test('parses cell kinds, languages and values', () => {
  const nb = parseNotebook(CANONICAL);
  assert.deepStrictEqual(
    nb.cells.map((c) => [c.kind, c.language, c.value]),
    [
      ['markdown', 'markdown', '# Title\n\nSome text'],
      ['code', 'python', 'import os\n\nx = 1'],
      ['code', 'sql', 'select 1 as id'],
      ['code', 'python', '%run ./helpers/setup'],
      ['code', 'python', '%pip install foo'],
    ]
  );
  assert.strictEqual(nb.cells[3].dbtitle, '1,Load helpers');
});

test('unedited canonical file round-trips byte-for-byte', () => {
  assert.strictEqual(roundTrip(CANONICAL), CANONICAL);
});

test('sample notebooks round-trip byte-for-byte', () => {
  const dir = path.join(__dirname, '..', 'samples');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.py'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.strictEqual(roundTrip(text), text, f);
  }
});

test('non-canonical files round-trip byte-for-byte', () => {
  const cases = [
    '',
    'print(1)\n',
    'print(1)', // plain script, no header
    '# Databricks notebook source',
    '# Databricks notebook source\n',
    '# Databricks notebook source\nx = 1', // no trailing newline
    '# Databricks notebook source\nx = 1\n\n\n', // extra trailing blank lines
    '# Databricks notebook source\n# COMMAND ----------\nx = 1\n', // tight separators
    '# Databricks notebook source\nx\n# COMMAND ----------\ny\n',
    '# Databricks notebook source\nx\n\n\n# COMMAND ----------\n\n\ny\n', // extra blank lines
    '# Databricks notebook source\nx\n\n# COMMAND ----------\n\n', // empty last cell
    '# Databricks notebook source\nx\n\n# COMMAND ----------', // separator at EOF
    '# Databricks notebook source\n# MAGIC %md # inline title\n# MAGIC \n# MAGIC trailing-space line above\n',
    '# Databricks notebook source\n# MAGIC %sql select 1\n',
    '# Databricks notebook source\n# MAGIC %md-sandbox\n# MAGIC <b>hi</b>\n',
    '# Databricks notebook source\n# DBTITLE 0,Hidden\nx = 1\n',
    '# Databricks notebook source\n# MAGIC %md\nmixed = "not all magic"\n',
    CANONICAL.replace(/\n/g, '\r\n'), // Windows line endings
  ];
  for (const text of cases) assert.strictEqual(roundTrip(text), text, JSON.stringify(text));
});

test('fuzz: arbitrary line soup round-trips byte-for-byte', () => {
  const pieces = [
    '# Databricks notebook source', '# COMMAND ----------', '# COMMAND ---------- ', '# MAGIC %md',
    '# MAGIC', '# MAGIC ', '# MAGIC %sql', '# MAGIC select 1', '# MAGIC %run ./x', '# DBTITLE 1,T',
    '', '', '', 'x = 1', '  indented', '%sql', '# comment',
  ];
  let seed = 42;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < 5000; i++) {
    const lines = Array.from({ length: rnd(14) }, () => pieces[rnd(pieces.length)]);
    if (rnd(4)) lines.unshift('# Databricks notebook source');
    const text = lines.join('\n') + (rnd(2) ? '\n' : '');
    assert.strictEqual(roundTrip(text), text, JSON.stringify(text));
  }
});

test('editing one cell leaves every other cell untouched', () => {
  const nb = parseNotebook(CANONICAL);
  nb.cells[1].value = 'import os\n\nx = 2';
  assert.strictEqual(serializeNotebook(nb), CANONICAL.replace('x = 1', 'x = 2'));
});

test('edited and new cells are written in canonical form', () => {
  const nb = parseNotebook(CANONICAL);
  nb.cells[0].value = '# New title';
  nb.cells[2].value = 'select 2 as id\n\nfrom t';
  nb.cells.push({ kind: 'code', language: 'sql', value: 'select 3' }); // new cell: no raw/sep
  nb.cells.push({ kind: 'markdown', language: 'markdown', value: 'note' });
  nb.cells.push({ kind: 'code', language: 'python', value: '%run ./other' });
  const out = serializeNotebook(nb);
  assert.ok(out.startsWith('# Databricks notebook source\n# MAGIC %md\n# MAGIC # New title\n\n# COMMAND ----------\n\n'));
  assert.ok(out.includes('# MAGIC %sql\n# MAGIC select 2 as id\n# MAGIC\n# MAGIC from t\n'));
  assert.ok(
    out.endsWith(
      '\n\n# COMMAND ----------\n\n# MAGIC %sql\n# MAGIC select 3' +
        '\n\n# COMMAND ----------\n\n# MAGIC %md\n# MAGIC note' +
        '\n\n# COMMAND ----------\n\n# MAGIC %run ./other\n'
    )
  );
  // and what we wrote parses back to the same cells
  const again = parseNotebook(out);
  assert.deepStrictEqual(
    again.cells.map((c) => [c.kind, c.language, c.value]),
    nb.cells.map((c) => [c.kind, c.language, c.value])
  );
});

test('reordering and deleting cells keeps a valid file', () => {
  const nb = parseNotebook(CANONICAL);
  nb.cells = [nb.cells[4], nb.cells[0], nb.cells[2]];
  const out = serializeNotebook(nb);
  assert.strictEqual(
    out,
    '# Databricks notebook source\n# MAGIC %pip install foo\n\n# COMMAND ----------\n\n' +
      '# MAGIC %md\n# MAGIC # Title\n# MAGIC\n# MAGIC Some text\n\n# COMMAND ----------\n\n' +
      '# MAGIC %sql\n# MAGIC select 1 as id\n'
  );
});

test('changing a cell language rewrites its magic', () => {
  const nb = parseNotebook(CANONICAL);
  nb.cells[2].language = 'python'; // sql -> python
  assert.ok(serializeNotebook(nb).includes('\n\nselect 1 as id\n\n'));
});

test('adding a cell to a plain script adds the notebook header', () => {
  const nb = parseNotebook('print(1)\n');
  nb.cells.push({ kind: 'code', language: 'python', value: 'print(2)' });
  assert.strictEqual(
    serializeNotebook(nb),
    '# Databricks notebook source\nprint(1)\n\n\n# COMMAND ----------\n\nprint(2)'
  );
});

test('Windows line endings inside an edited cell are normalised', () => {
  const nb = parseNotebook(CANONICAL);
  nb.cells[1].value = 'a = 1\r\nb = 2';
  assert.ok(serializeNotebook(nb).includes('\n\na = 1\nb = 2\n\n'));
});

test('renderCell/parseCell are inverses for generated cells', () => {
  const cells = [
    { kind: 'code', language: 'python', value: 'x = 1\n\ny = 2' },
    { kind: 'code', language: 'python', value: '' },
    { kind: 'code', language: 'sql', value: 'select 1' },
    { kind: 'code', language: 'shellscript', value: 'ls -la' },
    { kind: 'code', language: 'scala', value: 'val x = 1' },
    { kind: 'markdown', language: 'markdown', value: '# hi\n\nthere' },
    { kind: 'markdown', language: 'markdown', value: 'x', magic: 'md-sandbox' },
    { kind: 'code', language: 'python', value: '%pip install x', dbtitle: '1,Install' },
  ];
  for (const c of cells) assert.deepStrictEqual(parseCell(renderCell(c)), c);
});

test('a file with a byte-order mark round-trips byte-for-byte', () => {
  const withMark = '\uFEFF' + CANONICAL;
  const nb = parseNotebook(withMark);
  assert.strictEqual(nb.bom, true);
  assert.strictEqual(nb.header, '# Databricks notebook source\n', 'the mark is not a part of the header line');
  assert.strictEqual(nb.cells.length, parseNotebook(CANONICAL).cells.length);
  assert.strictEqual(roundTrip(withMark), withMark);
  assert.strictEqual(roundTrip(withMark.replace(/\n/g, '\r\n')), withMark.replace(/\n/g, '\r\n'));
  // A plain script with a mark keeps it too.
  assert.strictEqual(roundTrip('\uFEFFprint(1)\n'), '\uFEFFprint(1)\n');
  // A file without a mark gets none.
  assert.strictEqual('bom' in parseNotebook(CANONICAL), false);
});

test('hasHeader accepts the header line only', () => {
  assert.strictEqual(hasHeader('# Databricks notebook source'), true);
  assert.strictEqual(hasHeader('# Databricks notebook source  \r\nx = 1'), true);
  assert.strictEqual(hasHeader('# Databricks notebook sources'), false);
  assert.strictEqual(hasHeader('x = 1\n# Databricks notebook source'), false);
  // The function agrees with the parser: a file without the header is one Python cell.
  assert.strictEqual(parseNotebook('# Databricks notebook sources\n').header, '');
});

console.log(`${passed} passed${process.exitCode ? ', with failures' : ''}`);
