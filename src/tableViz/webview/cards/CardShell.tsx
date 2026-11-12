/**
 * The frame of a detail card: the name of the column, the buttons, and the SQL.
 *
 * Each kind of card puts its chart and its tables inside this frame.
 */
import type { ReactNode } from 'react';
import type { Card, ColumnInfo, ColumnKind } from '../../core/schema.ts';
import type { RequestError } from '../rpc.ts';

export const KIND_LABELS: Record<ColumnKind, string> = {
  continuous: 'Number',
  discrete: 'Discrete number',
  category: 'Category',
  identifier: 'Identifier',
  date: 'Date',
  complex: 'Complex',
};

/** A button that shows an icon. `label` is the text for the tooltip and for a screen reader. */
function IconButton(props: { icon: string; label: string; pressed?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="icon-button" title={props.label} aria-label={props.label} aria-pressed={props.pressed} onClick={props.onClick}>
      <span className={`codicon codicon-${props.icon}`} aria-hidden="true" />
    </button>
  );
}

/** Show an error from the host: the plain message, the next step, and the details on request. */
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

export interface CardShellProps {
  column: ColumnInfo;
  /** The settings of the card. */
  card: Card;
  /** The kind that the card shows now. */
  kind: ColumnKind;
  /** The kind that the feature selected for the column. */
  detected: ColumnKind;
  /** The kinds that the user can select. */
  kinds: ColumnKind[];
  /** Change settings of the card. */
  onChange: (patch: Partial<Card>) => void;
  onClose: () => void;
  /** The SQL statements behind the numbers on the card. */
  sql: string[];
  /** true if a number on the card is an estimate. The card then offers "Compute exactly". */
  approximate: boolean;
  /** true if the card has a chart. The card then has a button that shows the chart as a table. */
  hasChart: boolean;
  /** true while a request of the card runs. */
  loading: boolean;
  error?: RequestError;
  children?: ReactNode;
}

export function CardShell(props: CardShellProps) {
  const { column, card, kind, onChange } = props;
  return (
    <section className="card" aria-label={`Column ${column.name}`}>
      <header className="card-header">
        <h2>{column.name}</h2>
        <span className="type">{column.typeText}</span>
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
        <IconButton icon="code" label={card.showSql ? 'Hide SQL' : 'Show SQL'} pressed={card.showSql === true} onClick={() => onChange({ showSql: !card.showSql })} />
        <IconButton
          icon={card.pinned ? 'pinned' : 'pin'}
          label={card.pinned ? 'Unpin the card' : 'Pin the card to the board'}
          pressed={card.pinned}
          onClick={() => onChange({ pinned: !card.pinned })}
        />
        <IconButton icon="close" label="Close the card" onClick={props.onClose} />
        </div>
      </header>

      {props.error && <ErrorPanel error={props.error} />}
      {props.loading && !props.error && (
        <p className="status" role="status">
          Loading…
        </p>
      )}
      {props.children}

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
          {props.sql.length === 0 ? <p className="status">No SQL yet.</p> : props.sql.map((statement, i) => <pre key={i}>{statement}</pre>)}
        </div>
      )}
    </section>
  );
}
