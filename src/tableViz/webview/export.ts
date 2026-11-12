/**
 * Export a card: its chart as PNG or SVG, its tables as CSV, its SQL to an editor.
 *
 * The webview cannot write a file. It makes the content and sends it to
 * the extension host, which asks the user for a file and writes it.
 */
import { SVGRenderer } from 'echarts/renderers';
import * as echarts from 'echarts/core';
import { fileName, toCsv } from '../core/derive.ts';
import { chartPng, chartState } from './Chart.tsx';
import { send } from './rpc.ts';

echarts.use([SVGRenderer]);

/** The name of an export file: the title of the page (the table) and the name of the column. */
const nameFor = (column: string, extension: string) => fileName([document.title, column], extension);

/** The character that the page writes between groups of three digits: "," in English, "." or a space in other languages. */
const groupSeparator = new Intl.NumberFormat().formatToParts(1000).find((part) => part.type === 'group')?.value ?? ',';

/**
 * Get the text of a table cell for a CSV file.
 *
 * A number on the page has separators between groups of digits, for example
 * "110,000". A CSV file must have the plain number, so that a spreadsheet
 * program reads it as a number.
 */
function cellText(cell: Element): string {
  const text = (cell.textContent ?? '').trim();
  const numeric = cell.classList.contains('num') || (cell.tagName === 'TD' && cell.closest('table.stats') !== null);
  return numeric ? text.split(groupSeparator).join('') : text;
}

/**
 * Get the tables of a card as CSV text. Two tables have an empty line between them.
 *
 * @param card  The element of the card.
 */
export function tablesCsv(card: Element): string {
  const tables = [...card.querySelectorAll('table.data, table.stats')];
  return tables.map((table) => toCsv([...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('th, td')].map(cellText)))).join('\r\n');
}

/** Draw the first chart of a card again as SVG text. Returns undefined if the card has no chart. */
export function chartSvg(card: Element): string | undefined {
  const element = card.querySelector('.chart');
  const state = element && chartState(element);
  if (!state) return undefined;
  // A second chart that is not on the page. It draws to SVG text.
  const svg = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: state.width, height: state.height });
  try {
    svg.setOption({ ...(state.option as object), animation: false });
    return svg.renderToSVGString();
  } finally {
    svg.dispose();
  }
}

/** Save the tables of a card as a CSV file, or copy them. */
export function exportTables(card: Element, column: string, action: 'save' | 'copy'): void {
  send({ type: 'export', action, name: nameFor(column, 'csv'), format: 'csv', text: tablesCsv(card) });
}

/** Save the first chart of a card as an SVG file, or copy the SVG text. */
export function exportSvg(card: Element, column: string, action: 'save' | 'copy'): void {
  const text = chartSvg(card);
  if (text) send({ type: 'export', action, name: nameFor(column, 'svg'), format: 'svg', text });
}

/** Save the first chart of a card as a PNG file. */
export function savePng(card: Element, column: string): void {
  const element = card.querySelector('.chart');
  const url = element && chartPng(element, getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#ffffff');
  if (url) send({ type: 'export', action: 'save', name: nameFor(column, 'png'), format: 'png', base64: url.slice(url.indexOf(',') + 1) });
}

/**
 * Copy the first chart of a card as a PNG image.
 *
 * VS Code can copy text only, so the page copies the image itself. If the
 * page is not permitted to do that, the function saves the image.
 */
export async function copyPng(card: Element, column: string): Promise<void> {
  const element = card.querySelector('.chart');
  const url = element && chartPng(element, getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#ffffff');
  if (!url) return;
  try {
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  } catch {
    savePng(card, column);
  }
}

/** Open the SQL of a card in a text editor. */
export function openSql(sql: string[]): void {
  if (sql.length) send({ type: 'openSql', sql });
}
