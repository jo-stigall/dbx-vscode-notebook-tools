/**
 * The board: the facts of the table, the detail cards, and the overview of all columns.
 *
 * A click on a column name opens its detail card. A new card replaces the
 * cards that are not pinned. A pinned card stays, so that several columns
 * can sit side by side.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { openCard } from '../core/derive.ts';
import { displayTableName } from '../core/names.ts';
import type { BoardDatasets, BoardSettings, Card } from '../core/schema.ts';
import { ErrorPanel } from './cards/CardShell.tsx';
import { ColumnCard } from './cards/ColumnCard.tsx';
import { formatBytes, formatCount, formatTime } from './format.ts';
import { useResult } from './hooks.ts';
import { OverviewTable, overviewRows, useOverview, type Sort } from './Overview.tsx';
import { loadState, saveState } from './rpc.ts';

/** One fact in the header, for example "Rows: 110,000". */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Board({ datasets, settings }: { datasets: BoardDatasets; settings: BoardSettings }) {
  const dataset = datasets.a;
  const details = useResult({ type: 'tableDetails', dataset });
  const columns = details.status === 'done' ? details.result.columns : undefined;
  const overview = useOverview(dataset, columns);

  const saved = useMemo(() => loadState(), []);
  const [search, setSearch] = useState(saved?.ui?.search ?? '');
  const [sort, setSort] = useState<Sort>(saved?.ui?.sort ?? 'table');
  const [cards, setCards] = useState<Card[]>(saved?.cards ?? []);
  useEffect(() => saveState({ datasets, ui: { search, sort }, cards }), [datasets, search, sort, cards]);

  const rows = useMemo(() => (columns ? overviewRows(columns, overview, search, sort) : []), [columns, overview, search, sort]);
  const open = useMemo(() => new Set(cards.map((c) => c.column)), [cards]);

  // When the user opens a card, bring the cards into view.
  const cardsElement = useRef<HTMLDivElement>(null);
  const firstCard = cards[0]?.column;
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && firstCard) cardsElement.current?.scrollIntoView({ block: 'nearest' });
    mounted.current = true;
  }, [firstCard]);

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

      {columns && cards.length > 0 && (
        <div className="cards" ref={cardsElement}>
          {cards.map((card) => {
            const column = columns.find((c) => c.name === card.column);
            if (!column) return null; // The table has no column with this name now.
            return (
              <ColumnCard
                key={card.column}
                dataset={dataset}
                column={column}
                stats={overview.stats.get(column.name)}
                rowCount={overview.rowCount}
                overviewApproximate={overview.approximate}
                overviewSql={overview.sql.get(column.name) ?? []}
                card={card}
                settings={settings}
                onChange={(patch) => setCards((list) => list.map((c) => (c.column === card.column ? { ...c, ...patch } : c)))}
                onClose={() => setCards((list) => list.filter((c) => c.column !== card.column))}
              />
            );
          })}
        </div>
      )}

      <div className="toolbar">
        <input type="search" placeholder="Search columns" aria-label="Search columns by name" value={search} onChange={(e) => setSearch(e.target.value)} />
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

      <OverviewTable dataset={dataset} rows={rows} overview={overview} open={open} onOpen={(column) => setCards((list) => openCard(list, column))} />
    </main>
  );
}
