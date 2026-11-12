/**
 * The table overview: a header with the facts of the table, and one row for each column.
 *
 * The page asks for the columns first. Then it asks for the numbers of 25
 * columns at a time, so that one scan of the table serves many columns. Each
 * row fills in when its numbers arrive.
 */
import { useEffect, useMemo, useState } from 'react';
import { detectKind } from '../core/kinds.ts';
import { displayTableName } from '../core/names.ts';
import type { BoardDatasets, ColumnInfo, ColumnKind, Dataset, OverviewColumn } from '../core/schema.ts';
import { formatBytes, formatCount, formatPercent, formatTime } from './format.ts';
import { useResult } from './hooks.ts';
import { loadState, request, saveState, RequestError } from './rpc.ts';
import { Thumbnail } from './Thumbnail.tsx';

/** The number of columns in one overview request. */
const BATCH = 25;

type Sort = 'table' | 'nulls' | 'distinct';

const KIND_LABELS: Record<ColumnKind, string> = {
  continuous: 'Number',
  discrete: 'Discrete number',
  category: 'Category',
  identifier: 'Identifier',
  date: 'Date',
  complex: 'Complex',
};

interface OverviewState {
  rowCount?: number;
  stats: Map<string, OverviewColumn>;
  approximate: boolean;
  asOf?: string;
  error?: RequestError;
}

/** Get the overview numbers of all columns, one batch at a time. */
function useOverview(dataset: Dataset, columns: ColumnInfo[] | undefined): OverviewState {
  const key = JSON.stringify([dataset, columns?.map((c) => [c.name, c.typeText])]);
  const [state, setState] = useState<{ key: string; value: OverviewState }>({ key, value: { stats: new Map(), approximate: false } });
  useEffect(() => {
    if (!columns) return;
    let current = true;
    for (let i = 0; i < columns.length; i += BATCH) {
      const batch = columns.slice(i, i + BATCH).map((c) => ({ name: c.name, typeText: c.typeText }));
      request({ type: 'overview', dataset, columns: batch }).then(
        (result) => {
          if (!current) return;
          setState((prev) => {
            const old = prev.key === key ? prev.value : { stats: new Map<string, OverviewColumn>(), approximate: false };
            const stats = new Map(old.stats);
            for (const c of result.columns) stats.set(c.name, c);
            return {
              key,
              value: { ...old, stats, rowCount: result.rowCount, approximate: old.approximate || result.approximate, asOf: old.asOf ?? result.asOf },
            };
          });
        },
        (error: RequestError) => {
          if (!current) return;
          setState((prev) => ({ key, value: { ...(prev.key === key ? prev.value : { stats: new Map(), approximate: false }), error } }));
        }
      );
    }
    return () => {
      current = false;
    };
    // `key` is the dataset and the columns as text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.value : { stats: new Map(), approximate: false };
}

/** Show an error from the host: the plain message, the next step, and the details on request. */
function ErrorPanel({ error }: { error: RequestError }) {
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

/** One fact in the header, for example "Rows: 110,000". */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A small bar that shows a part of a total. The text next to it gives the same number. */
function ShareBar({ part, total }: { part: number; total: number }) {
  const width = total === 0 ? 0 : (part / total) * 40;
  return (
    <svg className="share" width="40" height="6" viewBox="0 0 40 6" aria-hidden="true">
      <rect className="share-track" width="40" height="6" />
      <rect className="share-fill" width={part > 0 ? Math.max(width, 1) : 0} height="6" />
    </svg>
  );
}

export function Overview({ datasets }: { datasets: BoardDatasets }) {
  const dataset = datasets.a;
  const details = useResult({ type: 'tableDetails', dataset });
  const columns = details.status === 'done' ? details.result.columns : undefined;
  const overview = useOverview(dataset, columns);

  const saved = useMemo(() => loadState()?.ui, []);
  const [search, setSearch] = useState(saved?.search ?? '');
  const [sort, setSort] = useState<Sort>(saved?.sort ?? 'table');
  useEffect(() => saveState({ datasets, ui: { search, sort } }), [datasets, search, sort]);

  const rows = useMemo(() => {
    if (!columns) return [];
    const needle = search.trim().toLowerCase();
    const list = columns
      .map((column, position) => {
        const stats = overview.stats.get(column.name);
        const nulls = stats && overview.rowCount !== undefined ? overview.rowCount - stats.nonNull : undefined;
        const kind = stats ? detectKind(column.typeText, stats.distinct, stats.nonNull) : undefined;
        return { column, position, stats, nulls, kind };
      })
      .filter((row) => !needle || row.column.name.toLowerCase().includes(needle));
    // Largest first. A row that has no number yet goes last.
    if (sort === 'nulls') list.sort((a, b) => (b.nulls ?? -1) - (a.nulls ?? -1) || a.position - b.position);
    if (sort === 'distinct') list.sort((a, b) => (b.stats?.distinct ?? -1) - (a.stats?.distinct ?? -1) || a.position - b.position);
    return list;
  }, [columns, overview, search, sort]);

  const name = displayTableName(dataset.table);
  if (details.status === 'error') {
    return (
      <main>
        <h1>{name}</h1>
        <ErrorPanel error={details.error} />
      </main>
    );
  }
  const facts = details.status === 'done' ? details.result : undefined;
  const approx = overview.approximate ? '≈ ' : '';

  return (
    <main>
      <header className="board-header">
        <h1>
          {name} <span className="badge">{dataset.profile}</span>
        </h1>
        <dl className="facts">
          <Fact label="Rows">{overview.rowCount === undefined ? '…' : formatCount(overview.rowCount)}</Fact>
          <Fact label="Size on disk">{facts?.sizeBytes === undefined ? '—' : formatBytes(facts.sizeBytes)}</Fact>
          <Fact label="Last modified">{facts?.lastModified ? formatTime(facts.lastModified) : '—'}</Fact>
          <Fact label="Partition columns">{facts ? facts.partitionColumns.join(', ') || 'None' : '…'}</Fact>
          {facts?.version !== undefined && <Fact label="Delta version">{facts.version}</Fact>}
        </dl>
      </header>

      {overview.error && <ErrorPanel error={overview.error} />}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search columns"
          aria-label="Search columns by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label>
          Sort by{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="table">Table order</option>
            <option value="nulls">Percent null</option>
            <option value="distinct">Distinct count</option>
          </select>
        </label>
        <span className="count" role="status">
          {columns ? `${rows.length} of ${columns.length} columns` : 'Loading columns…'}
        </span>
      </div>

      <table className="columns">
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Type</th>
            <th scope="col">Kind</th>
            <th scope="col" className="num">
              Null
            </th>
            <th scope="col" className="num">
              Distinct
            </th>
            <th scope="col">Values</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ column, stats, nulls, kind }) => (
            <tr key={column.name}>
              <th scope="row" className="name">
                {column.name}
                {column.partition && (
                  <span className="tag" title="The table is partitioned by this column">
                    partition
                  </span>
                )}
              </th>
              <td className="type">{column.typeText}</td>
              <td>{kind ? KIND_LABELS[kind] : '…'}</td>
              <td className="num">
                {nulls === undefined || overview.rowCount === undefined ? (
                  '…'
                ) : (
                  <>
                    {formatPercent(nulls, overview.rowCount)} <ShareBar part={nulls} total={overview.rowCount} />
                  </>
                )}
              </td>
              <td className="num">{!stats ? '…' : stats.distinct === undefined ? '—' : approx + formatCount(stats.distinct)}</td>
              <td>
                <Thumbnail dataset={dataset} column={column} stats={stats} kind={kind} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
