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
import type { BoardDatasets, BoardSettings, Card, Dataset } from '../core/schema.ts';
import { ErrorPanel } from './cards/CardShell.tsx';
import { ColumnCard } from './cards/ColumnCard.tsx';
import { DatasetBar } from './DatasetBar.tsx';
import { formatBytes, formatCount, formatTime } from './format.ts';
import { useResult } from './hooks.ts';
import { OverviewTable, overviewRows, useOverview, type Sort } from './Overview.tsx';
import { loadState, saveState } from './rpc.ts';

/**
 * The name of a profile for a person to read.
 *
 * @example
 * profileLabel('@workspace')                                // 'Notebook connection'
 * profileLabel('@token:https://adb-1.azuredatabricks.net')   // 'adb-1.azuredatabricks.net'
 */
function profileLabel(profile: string): string {
  if (profile === '@workspace') return 'Notebook connection';
  if (profile.startsWith('@token:')) return profile.slice(7).replace(/^https?:\/\//, '');
  return profile;
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

export function Board({ datasets: initial, settings }: { datasets: BoardDatasets; settings: BoardSettings }) {
  const saved = useMemo(() => loadState(), []);
  // The user can change the filter and the sample of the dataset. The table and the profile do not change.
  const [dataset, setDataset] = useState<Dataset>(initial.a);
  const datasets = useMemo(() => ({ ...initial, a: dataset }), [initial, dataset]);

  const details = useResult({ type: 'tableDetails', dataset });
  const facts = details.status === 'done' ? details.result : undefined;
  const columns = facts?.columns;

  // All queries read the Delta version that the table had when the board read its details.
  // The cards then show the same data, also while a job writes to the table.
  const version = facts?.version;
  const pinned = useMemo<Dataset>(() => (version && !dataset.version ? { ...dataset, version: { kind: 'version', n: version } } : dataset), [dataset, version]);

  // Before the first scan of a very large table, ask. A filter or a sample makes the scan small, so then there is no question.
  const [scanLarge, setScanLarge] = useState(saved?.scanLarge ?? false);
  const tooLarge = facts?.sizeBytes !== undefined && facts.sizeBytes > settings.largeTableBytes && !dataset.filter && !dataset.sample && !scanLarge;
  const overview = useOverview(pinned, tooLarge ? undefined : columns);

  const [search, setSearch] = useState(saved?.ui?.search ?? '');
  const [sort, setSort] = useState<Sort>(saved?.ui?.sort ?? 'table');
  const [cards, setCards] = useState<Card[]>(saved?.cards ?? []);
  useEffect(() => saveState({ datasets, ui: { search, sort }, cards, scanLarge }), [datasets, search, sort, cards, scanLarge]);

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
  const sample = dataset.sample?.percent;

  return (
    <main>
      <header className="board-header">
        <h1>
          {name} <span className="badge">{profileLabel(dataset.profile)}</span>
          {sample !== undefined && (
            <span className="sampled" title="The queries read a sample of the rows. All counts are estimates.">
              Sampled {sample}%
            </span>
          )}
        </h1>
        <dl className="facts">
          <Fact label={sample === undefined ? (dataset.filter ? 'Rows (filtered)' : 'Rows') : 'Rows in the sample'}>
            {overview.rowCount === undefined ? (tooLarge ? '—' : '…') : formatCount(overview.rowCount)}
          </Fact>
          <Fact label="Size on disk">{facts?.sizeBytes === undefined ? '—' : formatBytes(facts.sizeBytes)}</Fact>
          <Fact label="Last modified">{facts?.lastModified ? formatTime(facts.lastModified) : '—'}</Fact>
          <Fact label="Partition columns">{facts ? facts.partitionColumns.join(', ') || 'None' : '…'}</Fact>
          {facts?.version !== undefined && <Fact label="Delta version">{facts.version}</Fact>}
        </dl>
      </header>

      <DatasetBar dataset={dataset} pinned={pinned} facts={facts} asOf={overview.asOf} onChange={setDataset} />

      {tooLarge && (
        <div className="notice" role="alert">
          <p>
            <strong>This table is {formatBytes(facts?.sizeBytes ?? 0)}.</strong> A query that reads all rows can take a long time and cost money.
          </p>
          <p>
            <button type="button" onClick={() => setDataset({ ...dataset, sample: { percent: 1 } })}>
              Use a 1% sample
            </button>{' '}
            <button type="button" onClick={() => setScanLarge(true)}>
              Read all rows
            </button>{' '}
            You can also type a filter.
          </p>
        </div>
      )}

      {overview.error && <ErrorPanel error={overview.error} />}

      {columns && !tooLarge && cards.length > 0 && (
        <div className="cards" ref={cardsElement}>
          {cards.map((card) => {
            const column = columns.find((c) => c.name === card.column);
            if (!column) return null; // The table has no column with this name now.
            return (
              <ColumnCard
                key={card.column}
                dataset={pinned}
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

      <OverviewTable dataset={pinned} rows={rows} overview={overview} open={open} onOpen={(column) => setCards((list) => openCard(list, column))} />
    </main>
  );
}
