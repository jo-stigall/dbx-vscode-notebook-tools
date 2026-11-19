/**
 * Helpers for copying a table name from the board: an icon button next to the
 * name, and the `data-vscode-context` payloads for the right-click menu.
 *
 * The webview cannot always write to the clipboard directly, so the button
 * sends a "copyText" message to the extension host. For right-click, VS Code
 * reads `data-vscode-context` from the clicked element up to `document.body`
 * and shows the matching commands from `menus["webview/context"]` in
 * package.json.
 */
import { useEffect, useRef, useState } from 'react';
import { send } from './rpc.ts';

/**
 * The `webviewSection` value for a region that represents one table.
 * package.json shows "Copy Table Name" in the right-click menu for this value.
 */
export const TABLE_CONTEXT_SECTION = 'dbxNotebook.tableViz.table';

/**
 * The `webviewSection` value for a compare board outside a single-table region.
 * package.json shows "Copy Table A Name" and "Copy Table B Name" for this value.
 */
export const COMPARE_CONTEXT_SECTION = 'dbxNotebook.tableViz.compare';

/** How long the copy button shows a check mark after a click, in milliseconds. */
const COPIED_RESET_MS = 1500;

/**
 * Build the `data-vscode-context` value for a single table.
 *
 * When the user right-clicks an element with this attribute in VS Code, the
 * context menu offers "Copy Table Name" and passes this object to the command
 * `dbxNotebook.tableViz.copyTableName`.
 *
 * @example
 * tableContext('main.shop.orders')
 * // '{"webviewSection":"dbxNotebook.tableViz.table","tableName":"main.shop.orders"}'
 */
export function tableContext(tableName: string): string {
  return JSON.stringify({ webviewSection: TABLE_CONTEXT_SECTION, tableName });
}

/**
 * Build the `data-vscode-context` value for a compare board with datasets A and B.
 *
 * When the user right-clicks an element with this attribute in VS Code, the
 * context menu offers "Copy Table A Name" and "Copy Table B Name".
 *
 * @example
 * compareContext('demo.shop.orders_2025', 'demo.shop.orders_2026')
 * // '{"webviewSection":"dbxNotebook.tableViz.compare","tableNameA":"demo.shop.orders_2025","tableNameB":"demo.shop.orders_2026"}'
 */
export function compareContext(tableNameA: string, tableNameB: string): string {
  return JSON.stringify({ webviewSection: COMPARE_CONTEXT_SECTION, tableNameA, tableNameB });
}

/**
 * Mirror the board's `data-vscode-context` onto `document.body`.
 *
 * Putting the attribute on `document.body` ensures right-clicking the outer
 * padding or empty space below `<main>` still opens the copy menu.
 */
export function useBodyContext(context: string): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.dataset.vscodeContext = context;
    return () => {
      delete document.body.dataset.vscodeContext;
    };
  }, [context]);
}

/**
 * A small icon button next to a table name that copies the name to the clipboard.
 *
 * A click sends `{ type: 'copyText', text: name }` to the extension host and
 * briefly switches the icon from `copy` to `check` as immediate confirmation.
 *
 * @example
 * <CopyTableButton name="demo.shop.orders_2026" />
 */
export function CopyTableButton({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setCopied(false);
    return () => clearTimeout(timer.current);
  }, [name]);

  const copy = () => {
    send({ type: 'copyText', text: name });
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <button
      type="button"
      className={`icon-button copy-table-button${copied ? ' copied' : ''}`}
      title={copied ? 'Copied' : `Copy ${name}`}
      aria-label={copied ? `Copied ${name}` : `Copy table name ${name}`}
      onClick={copy}
    >
      <span className={`codicon codicon-${copied ? 'check' : 'copy'}`} aria-hidden="true" />
    </button>
  );
}
