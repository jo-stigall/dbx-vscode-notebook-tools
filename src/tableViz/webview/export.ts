/**
 * Export a card: its chart as PNG or SVG, its tables as CSV, its SQL to an editor.
 *
 * The webview cannot write a file. It makes the content and sends it to
 * the extension host, which asks the user for a file and writes it.
 *
 * The "Save or copy" menu of a card calls these functions. See CardShell.tsx.
 */
import { SVGRenderer } from 'echarts/renderers';
import * as echarts from 'echarts/core';
import { fileName, toCsv } from '../core/derive.ts';
import { chartPng, chartState } from './Chart.tsx';
import { send } from './rpc.ts';

echarts.use([SVGRenderer]);

/**
 * Make the name of an export file from the title of the page (the table) and the name of the column.
 *
 * @example
 * // The title of the page is 'main.shop.orders'.
 * nameFor('amount', 'csv')       // 'main.shop.orders_amount.csv'
 * nameFor('unit price', 'png')   // 'main.shop.orders_unit_price.png'
 */
const nameFor = (column: string, extension: string) => fileName([document.title, column], extension);

/** The character that the page writes between groups of three digits: "," in English, "." or a space in other languages. */
const groupSeparator = new Intl.NumberFormat().formatToParts(1000).find((part) => part.type === 'group')?.value ?? ',';

/**
 * Get the text of a table cell for a CSV file.
 *
 * A number on the page has separators between groups of digits, for example
 * "110,000". A CSV file must have the plain number, so that a spreadsheet
 * program reads it as a number.
 *
 * The function removes the separators only from a cell that holds a number:
 * a cell with the class "num", or a value cell of a statistics table.
 *
 * @example
 * // <td class="num">110,000</td>
 * cellText(cell)   // '110000'
 * // <td>web, mobile</td>   (a value of the column, not a number)
 * cellText(cell)   // 'web, mobile'
 */
function cellText(cell: Element): string {
  const text = (cell.textContent ?? '').trim();
  const numeric = cell.classList.contains('num') || (cell.tagName === 'TD' && cell.closest('table.stats') !== null);
  return numeric ? text.split(groupSeparator).join('') : text;
}

/**
 * Get the tables of a card as CSV text. Two tables have an empty line between them.
 *
 * @example
 * // The card shows the histogram as a table with one row, and a statistics table with one row.
 * tablesCsv(card)
 * // 'Range,Rows,Percent\r\n0 to 25,60352,54.9%\r\n\r\nCount,110000\r\n'
 *
 * @param card  The element of the card.
 * @returns An empty string if the card has no table.
 */
export function tablesCsv(card: Element): string {
  const tables = [...card.querySelectorAll('table.data, table.stats')];
  return tables.map((table) => toCsv([...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('th, td')].map(cellText)))).join('\r\n');
}

/**
 * Draw the first chart of a card again as SVG text.
 *
 * The chart on the page is a canvas, which has pixels and no SVG. The
 * function gives the settings of that chart to a second chart of the same
 * size, and the second chart writes SVG.
 *
 * @example
 * // The chart of the card is 560 pixels wide and 220 pixels high.
 * chartSvg(card)   // '<svg width="560" height="220" xmlns="http://www.w3.org/2000/svg" ...>...</svg>'
 *
 * @param card  The element of the card.
 * @returns undefined if the card has no chart.
 */
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

/**
 * Save the tables of a card as a CSV file, or copy them.
 *
 * The function sends the CSV text to the host. The host asks the user for a
 * file, or puts the text on the clipboard.
 *
 * @example
 * exportTables(card, 'amount', 'save')   // the host proposes the file name 'main.shop.orders_amount.csv'
 *
 * @param card  The element of the card.
 * @param column  The name of the column of the card. It becomes a part of the file name.
 * @param action  'save': write a file. 'copy': put the text on the clipboard.
 */
export function exportTables(card: Element, column: string, action: 'save' | 'copy'): void {
  send({ type: 'export', action, name: nameFor(column, 'csv'), format: 'csv', text: tablesCsv(card) });
}

/**
 * Save the first chart of a card as an SVG file, or copy the SVG text.
 *
 * The function does nothing if the card has no chart.
 *
 * @example
 * exportSvg(card, 'amount', 'copy')   // the SVG text of the histogram of `amount` goes on the clipboard
 */
export function exportSvg(card: Element, column: string, action: 'save' | 'copy'): void {
  const text = chartSvg(card);
  if (text) send({ type: 'export', action, name: nameFor(column, 'svg'), format: 'svg', text });
}

/**
 * Save the first chart of a card as a PNG file.
 *
 * The image has the background color of the editor. Its width and height
 * are two times those of the chart on the page, so that the image is sharp.
 * The function does nothing if the card has no chart.
 *
 * @example
 * savePng(card, 'amount')   // the host proposes the file name 'main.shop.orders_amount.png'
 */
export function savePng(card: Element, column: string): void {
  const element = card.querySelector('.chart');
  const url = element && chartPng(element, getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#ffffff');
  if (url) send({ type: 'export', action: 'save', name: nameFor(column, 'png'), format: 'png', base64: url.slice(url.indexOf(',') + 1) });
}

/**
 * Copy the first chart of a card as a PNG image.
 *
 * VS Code can copy text only, so the page copies the image itself. If the
 * browser of the webview does not permit that, the function saves the image
 * as a file. See savePng().
 *
 * @example
 * await copyPng(card, 'amount')   // the picture of the histogram of `amount` is on the clipboard
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

/**
 * Open the SQL of a card in a text editor.
 *
 * The function does nothing if the list is empty: a card has no SQL before
 * its first result arrives.
 *
 * @example
 * openSql(['SELECT count(*) AS `n` FROM `main`.`shop`.`orders`'])   // the host opens a new editor that contains this statement
 *
 * @param sql  The SQL statements that gave the numbers on the card.
 */
export function openSql(sql: string[]): void {
  if (sql.length) send({ type: 'openSql', sql });
}
