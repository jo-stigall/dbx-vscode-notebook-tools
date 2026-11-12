/**
 * The frame of a detail card: the name of the column, the buttons, and the SQL.
 *
 * Each kind of card puts its chart and its tables inside this frame. The
 * cards of one table (ColumnCard.tsx) and the cards of compare mode
 * (compare/CompareCard.tsx) use the same frame.
 */
import { useRef, type ReactNode } from 'react';
import type { Card, ColumnInfo, ColumnKind } from '../../core/schema.ts';
import { copyPng, exportSvg, exportTables, openSql, savePng } from '../export.ts';
import type { RequestError } from '../rpc.ts';

/**
 * The name of each kind of column on the page: in the "Kind" column of the overview and in the kind list of a card.
 *
 * @example
 * KIND_LABELS.continuous   // 'Number'
 */
export const KIND_LABELS: Record<ColumnKind, string> = {
  continuous: 'Number',
  discrete: 'Discrete number',
  category: 'Category',
  identifier: 'Identifier',
  date: 'Date',
  complex: 'Complex',
};

/**
 * A button that shows an icon. `label` is the text for the tooltip and for a screen reader.
 *
 * @example
 * <IconButton icon="close" label="Close the card" onClick={onClose} />
 *
 * @param icon  The name of a VS Code codicon without "codicon-". Example: 'pin'.
 * @param pressed  For a button that is on or off: true shows a border around the button.
 */
function IconButton(props: { icon: string; label: string; pressed?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="icon-button" title={props.label} aria-label={props.label} aria-pressed={props.pressed} onClick={props.onClick}>
      <span className={`codicon codicon-${props.icon}`} aria-hidden="true" />
    </button>
  );
}

/**
 * Show an error from the host: the plain message, the next step, and the details on request.
 *
 * A click on "Details" shows the error text from Databricks and the SQL of
 * the request that failed.
 *
 * @example
 * <ErrorPanel error={new RequestError('The table does not exist.', { nextStep: 'Check the name of the table.' })} />
 */
export function ErrorPanel({ error }: { error: RequestError }) {
  return (
    <div className="error" role="alert">
      <p className="error-message">{error.message}</p>
      {error.nextStep && <p>{error.nextStep}</p>}
      {(error.raw !== error.message || error.sql.length > 0) && (
        <details>
          <summary>Details</summary>
          <pre>{[error.raw, ...error.sql].join('\n\n')}</pre>
        </details>
      )}
    </div>
  );
}

/** The properties of the `CardShell` component. */
export interface CardShellProps {
  /** The header shows the name and the type of this column. */
  column: ColumnInfo;
  /** The settings of the card: pinned, detailed view, chart or table, SQL shown. */
  card: Card;
  /** The kind that the card shows now. */
  kind: ColumnKind;
  /** The kind that the feature selected for the column. The kind list marks it with "(detected)". */
  detected: ColumnKind;
  /** The kinds that the user can select. With 0 or 1 kinds, the header has no kind list. */
  kinds: ColumnKind[];
  /** The user changed settings of the card. Example: a click on the pin calls `onChange({ pinned: true, expanded: false })`. */
  onChange: (patch: Partial<Card>) => void;
  /** The user clicked "Close the card". */
  onClose: () => void;
  /** The SQL statements behind the numbers on the card. */
  sql: string[];
  /** true if a number on the card is an estimate. The card then offers "Compute exactly". */
  approximate: boolean;
  /** true if the card has a chart. The card then has a button that shows the chart as a table. */
  hasChart: boolean;
  /** true while a request of the card runs. */
  loading: boolean;
  /** 'queued': the query of the card waits for a free place on Databricks. */
  progress?: 'queued' | 'running';
  /** true if the user cancelled a request of the card. The card then tells the user to click "Refresh". */
  cancelled?: boolean;
  /** Set if the dataset is a sample: the percent of the rows that the queries read. */
  samplePercent?: number;
  /** true if the card shows the numbers of an older request while a newer request runs. The card then shows them dimmed. */
  stale?: boolean;
  /** The error of a request of the card. The card shows it above its content. */
  error?: RequestError;
  /** The content of the card: its controls, its chart and its tables. */
  children?: ReactNode;
}

/** One number in the row of large numbers at the top of a detailed view. */
export interface Tile {
  /** The small text above the number. Example: 'Mean'. */
  label: string;
  /** The number, as text. Example: '62.48'. */
  value: ReactNode;
  /** A second, smaller line. Example: the percent that belongs to a count. */
  note?: string;
}

/**
 * The row of large numbers at the top of a detailed view.
 *
 * The tiles show the facts that a person looks for first, such as the
 * count, the nulls and the mean.
 *
 * @example
 * <StatTiles tiles={[{ label: 'Count', value: '109,500' }, { label: 'Nulls', value: '500', note: '0.5%' }]} />
 */
export function StatTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <dl className="tiles">
      {tiles.map((tile) => (
        <div className="tile" key={tile.label}>
          <dt>{tile.label}</dt>
          <dd>
            {tile.value}
            {tile.note && <span className="tile-note">{tile.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The frame of one detail card.
 *
 * The user sees the name and the type of the column, a row of buttons, the
 * content of the card, and below it the note about estimates and the SQL.
 *
 * What the buttons do. Each one calls `onChange` with the new setting,
 * except "Save or copy" and "Close":
 *
 * | Control                 | Effect                                                              |
 * |-------------------------|---------------------------------------------------------------------|
 * | Kind list               | Shows the column as a different kind, for example a number as a category. |
 * | Table / chart           | Shows the numbers of the chart as a table, or the chart again.      |
 * | Save or copy            | Opens a menu: save or copy the chart, the tables or the SQL. See export.ts. |
 * | Show SQL                | Shows or hides the SQL statements behind the numbers.               |
 * | Detailed view           | Changes between the detailed view and a small card.                 |
 * | Pin                     | Keeps the card on the board when the user opens a different column. A pinned card becomes small. |
 * | Close                   | Calls `onClose`.                                                    |
 * | Compute exactly         | Shows only below a card that has an estimate. Asks for exact numbers. |
 *
 * While a request runs, the card shows a thin line that moves along its top
 * edge. A card with no numbers yet shows a grey block with "Loading…". A
 * card with old numbers shows them dimmed.
 *
 * @example
 * <CardShell column={column} card={card} kind="continuous" detected="continuous" kinds={['continuous', 'category']}
 *   onChange={setCard('amount')} onClose={closeCard('amount')} sql={stats.result.sql} approximate={false} hasChart loading={false}>
 *   <ContinuousView ... />
 * </CardShell>
 */
export function CardShell(props: CardShellProps) {
  const { column, card, kind, onChange } = props;
  const section = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  /** Run an export function on this card, then close the menu. */
  const run = (action: (card: Element) => void) => () => {
    if (section.current) action(section.current);
    if (menu.current) menu.current.open = false;
  };
  const detailed = card.expanded === true;
  // A request runs: the first one of the card, or a newer one while the card shows older numbers.
  const busy = (props.loading || props.stale === true) && !props.error && !props.cancelled;
  return (
    <section
      className={`card${detailed ? ' expanded' : ''}${props.stale ? ' stale' : ''}`}
      aria-label={`Column ${column.name}`}
      aria-busy={busy}
      data-card={column.name}
      ref={section}
    >
      {busy && <div className="busy-bar" aria-hidden="true" />}
      <header className="card-header">
        <h2>{column.name}</h2>
        <span className="type">{column.typeText}</span>
        {props.samplePercent !== undefined && (
          <span className="sampled" title="The queries read a sample of the rows. All counts are estimates.">
            Sampled {props.samplePercent}%
          </span>
        )}
        <span className="spacer" />
        <div className="card-actions">
        {props.kinds.length > 1 && (
          <select
            aria-label="Kind of column"
            title="How to show this column"
            value={kind}
            onChange={(e) => onChange({ kind: e.target.value === props.detected ? undefined : (e.target.value as ColumnKind) })}
          >
            {props.kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k] + (k === props.detected ? ' (detected)' : '')}
              </option>
            ))}
          </select>
        )}
        {props.hasChart && (
          <IconButton
            icon={card.asTable ? 'graph' : 'table'}
            label={card.asTable ? 'Show the chart' : 'Show the chart as a table'}
            onClick={() => onChange({ asTable: !card.asTable })}
          />
        )}
        <details className="menu" ref={menu}>
          <summary className="icon-button" title="Save or copy" aria-label="Save or copy the chart, the tables or the SQL of this card">
            <span className="codicon codicon-export" aria-hidden="true" />
          </summary>
          <div className="menu-items">
            {props.hasChart && !card.asTable && (
              <>
                <button type="button" onClick={run((el) => savePng(el, column.name))}>
                  Save chart as PNG
                </button>
                <button type="button" onClick={run((el) => exportSvg(el, column.name, 'save'))}>
                  Save chart as SVG
                </button>
                <button type="button" onClick={run((el) => void copyPng(el, column.name))}>
                  Copy chart
                </button>
              </>
            )}
            <button type="button" onClick={run((el) => exportTables(el, column.name, 'save'))}>
              Save tables as CSV
            </button>
            <button type="button" onClick={run((el) => exportTables(el, column.name, 'copy'))}>
              Copy tables
            </button>
            <button type="button" disabled={props.sql.length === 0} onClick={run(() => openSql(props.sql))}>
              Open SQL in Editor
            </button>
          </div>
        </details>
        <IconButton icon="code" label={card.showSql ? 'Hide SQL' : 'Show SQL'} pressed={card.showSql === true} onClick={() => onChange({ showSql: !card.showSql })} />
        <IconButton
          icon={detailed ? 'screen-normal' : 'screen-full'}
          label={detailed ? 'Show as a small card' : 'Show the detailed view'}
          onClick={() => onChange({ expanded: !detailed })}
        />
        <IconButton
          icon={card.pinned ? 'pinned' : 'pin'}
          label={card.pinned ? 'Unpin the card' : 'Pin the card to the board'}
          pressed={card.pinned}
          // A pinned card becomes small, so that it fits next to the detailed view of the next column.
          onClick={() => onChange(card.pinned ? { pinned: false } : { pinned: true, expanded: false })}
        />
        <IconButton icon="close" label="Close the card" onClick={props.onClose} />
        </div>
      </header>

      {props.error && <ErrorPanel error={props.error} />}
      {props.cancelled && !props.error && <p className="status">Cancelled. Click "Refresh" to run the queries again.</p>}
      {props.loading && !props.error && !props.cancelled && (
        <div className="skeleton card-wait" role="status">
          {props.progress === 'queued' ? 'Waiting for a free place on Databricks…' : 'Loading…'}
        </div>
      )}
      <div className="card-content">{props.children}</div>

      {props.approximate && (
        <p className="approx-note">
          ≈ marks an estimate.{' '}
          <button type="button" className="link" onClick={() => onChange({ exact: true })}>
            Compute exactly
          </button>
        </p>
      )}
      {card.showSql && (
        <div className="sql">
          {props.sql.length === 0 ? (
            <p className="status">No SQL yet.</p>
          ) : (
            <>
              <button type="button" className="link" onClick={() => openSql(props.sql)}>
                Open SQL in Editor
              </button>
              {props.sql.map((statement, i) => (
                <pre key={i}>{statement}</pre>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
