/**
 * The board: the facts of the table, the detail cards, and the overview of all columns.
 *
 * A click on a column name opens its detail card. A new card replaces the
 * cards that are not pinned. A pinned card stays, so that several columns
 * can sit side by side.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addChip, openCard } from '../core/derive.ts';
import { matchColumns } from '../core/match.ts';
import { displayTableName, parseTableName } from '../core/names.ts';
import type { BoardDatasets, BoardSettings, BoardState, Card, Chip, Dataset } from '../core/schema.ts';
import { ErrorPanel } from './cards/CardShell.tsx';
import { ColumnCard } from './cards/ColumnCard.tsx';
import { CompareCard } from './compare/CompareCard.tsx';
import { CompareTable, compareRows, SchemaPanel } from './compare/CompareOverview.tsx';
import { useDrifts } from './compare/useCompare.ts';
import { DatasetBar } from './DatasetBar.tsx';
import { formatBytes, formatCount, formatTime } from './format.ts';
import { useResult } from './hooks.ts';
import { OverviewTable, overviewRows, useOverview, type Sort } from './Overview.tsx';
import { loadState, saveState, send } from './rpc.ts';

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

export function Board({ datasets: initial, settings, initialState }: { datasets: BoardDatasets; settings: BoardSettings; initialState?: BoardState }) {
  // The cards and settings: from a saved view, or from the state that the page stored before a window reload.
  const saved = useMemo(() => initialState ?? loadState(), [initialState]);
  // The user can change the filter and the sample of the dataset. The table and the profile do not change.
  const [dataset, setDataset] = useState<Dataset>(initial.a);
  // Dataset B is set in compare mode only. The user can add it and remove it.
  const [datasetB, setDatasetB] = useState<Dataset | undefined>(initial.b);
  const datasets = useMemo<BoardDatasets>(() => ({ a: dataset, ...(datasetB ? { b: datasetB } : {}) }), [dataset, datasetB]);

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

  // Compare mode: the same steps for dataset B. Each request names one dataset, so the answers for A stay when B changes.
  const detailsB = useResult(datasetB ? { type: 'tableDetails', dataset: datasetB } : undefined);
  const factsB = datasetB && detailsB.status === 'done' ? detailsB.result : undefined;
  const versionB = factsB?.version;
  const pinnedB = useMemo<Dataset | undefined>(
    () => (datasetB && versionB && !datasetB.version ? { ...datasetB, version: { kind: 'version', n: versionB } } : datasetB),
    [datasetB, versionB]
  );
  const overviewB = useOverview(pinnedB ?? pinned, pinnedB && !tooLarge ? factsB?.columns : undefined);
  const schema = useMemo(
    () => (columns && factsB ? matchColumns(columns, factsB.columns, { caseSensitive: settings.matchColumnsCaseSensitive }) : undefined),
    [columns, factsB, settings.matchColumnsCaseSensitive]
  );
  const [asText, setAsText] = useState<string[]>(saved?.asText ?? []);
  const drifts = useDrifts(pinned, pinnedB ?? pinned, schema?.pairs ?? [], overview, overviewB, asText);

  const [search, setSearch] = useState(saved?.ui?.search ?? '');
  // In compare mode, the columns that changed most come first.
  const [sort, setSort] = useState<Sort>(saved?.ui?.sort ?? (initial.b ? 'drift' : 'table'));
  const [cards, setCards] = useState<Card[]>(saved?.cards ?? []);
  const state = useMemo<BoardState>(() => ({ datasets, ui: { search, sort }, cards, scanLarge, asText }), [datasets, search, sort, cards, scanLarge, asText]);
  useEffect(() => saveState(state), [state]);
  /** Write the board to a `.tableviz.json` file. The host asks for the file. */
  const saveView = () => send({ type: 'saveView', state });

  /** Put a table on the board as dataset B, or remove dataset B. */
  const compareWith = (next: Dataset | undefined) => {
    setDatasetB(next);
    setSort(next ? 'drift' : 'table');
  };
  const [compareDraft, setCompareDraft] = useState('');
  const compareTable = parseTableName(compareDraft);

  const rows = useMemo(() => (columns ? overviewRows(columns, overview, search, sort) : []), [columns, overview, search, sort]);
  const pairRows = useMemo(() => (schema ? compareRows(schema, overview, overviewB, drifts, search, sort) : []), [schema, overview, overviewB, drifts, search, sort]);
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
  const setCard = (column: string) => (patch: Partial<Card>) => setCards((list) => list.map((c) => (c.column === column ? { ...c, ...patch } : c)));
  const closeCard = (column: string) => () => setCards((list) => list.filter((c) => c.column !== column));
  // A click on a bar adds a filter chip to the dataset. All cards then ask for their numbers again.
  const addFilter = (chip: Chip) => setDataset((d) => addChip(d, chip));
  const toolbar = (shown: number, total: number | undefined, what: string) => (
    <div className="toolbar">
      <input type="search" placeholder="Search columns" aria-label="Search columns by name" value={search} onChange={(e) => setSearch(e.target.value)} />
      <label>
        Sort by{' '}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {datasetB && <option value="drift">Drift score</option>}
          <option value="table">Table order</option>
          <option value="nulls">Percent null</option>
          <option value="distinct">Distinct count</option>
        </select>
      </label>
      <span className="count" role="status">
        {total === undefined ? 'Loading columns…' : `${shown} of ${total} ${what}`}
      </span>
    </div>
  );

  if (datasetB && pinnedB) {
    const difference = overview.rowCount !== undefined && overviewB.rowCount !== undefined ? overviewB.rowCount - overview.rowCount : undefined;
    return (
      <main>
        <header className="board-header">
          <h1>
            <span className="chip chip-a">A</span> {name} <span className="versus">compared with</span> <span className="chip chip-b">B</span> {displayTableName(datasetB.table)}{' '}
            <span className="badge">{profileLabel(dataset.profile)}</span>
          </h1>
          <dl className="facts">
            <Fact label="Rows in A">{overview.rowCount === undefined ? '…' : formatCount(overview.rowCount)}</Fact>
            <Fact label="Rows in B">{overviewB.rowCount === undefined ? '…' : formatCount(overviewB.rowCount)}</Fact>
            <Fact label="Difference (B − A)">
              {difference === undefined
                ? '…'
                : `${difference > 0 ? '+' : ''}${formatCount(difference)}${overview.rowCount ? ` (${difference > 0 ? '+' : ''}${((difference / overview.rowCount) * 100).toFixed(1)}%)` : ''}`}
            </Fact>
          </dl>
        </header>

        <DatasetBar label="A" dataset={dataset} pinned={pinned} facts={facts} asOf={overview.asOf} onChange={setDataset} onSaveView={saveView} />
        <DatasetBar label="B" dataset={datasetB} pinned={pinnedB} facts={factsB} asOf={overviewB.asOf} onChange={setDatasetB} onRemove={() => compareWith(undefined)} hideActions />

        {detailsB.status === 'error' && <ErrorPanel error={detailsB.error} />}
        {overview.error && <ErrorPanel error={overview.error} />}
        {overviewB.error && <ErrorPanel error={overviewB.error} />}
        {schema && <SchemaPanel schema={schema} asText={asText} onAsText={setAsText} />}

        {schema && cards.length > 0 && (
          <div className="cards" ref={cardsElement}>
            {cards.map((card) => {
              const pair = schema.pairs.find((p) => p.a.name === card.column);
              if (!pair) return null; // The column is not in the two datasets.
              return (
                <CompareCard
                  key={card.column}
                  a={pinned}
                  b={pinnedB}
                  pair={pair}
                  statsA={overview.stats.get(pair.a.name)}
                  statsB={overviewB.stats.get(pair.b.name)}
                  rowsA={overview.rowCount}
                  rowsB={overviewB.rowCount}
                  drift={drifts.get(pair.a.name) ?? { status: 'loading' }}
                  card={card}
                  settings={settings}
                  onChange={setCard(card.column)}
                  onClose={closeCard(card.column)}
                  onFilter={(make) => {
                    // The same selection filters A and B. The column can have a different name or type in B.
                    const chipA = make({ name: pair.a.name, typeText: pair.a.typeText });
                    const chipB = make({ name: pair.b.name, typeText: pair.b.typeText });
                    if (chipA) addFilter(chipA);
                    if (chipB) setDatasetB((d) => d && addChip(d, chipB));
                  }}
                />
              );
            })}
          </div>
        )}

        {toolbar(pairRows.length, schema?.pairs.length, 'columns that A and B have')}
        <CompareTable rows={pairRows} a={overview} b={overviewB} open={open} onOpen={(column) => setCards((list) => openCard(list, column))} />
      </main>
    );
  }

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
          <Fact label={sample === undefined ? (dataset.filter || dataset.chips?.length ? 'Rows (filtered)' : 'Rows') : 'Rows in the sample'}>
            {overview.rowCount === undefined ? (tooLarge ? '—' : '…') : formatCount(overview.rowCount)}
          </Fact>
          <Fact label="Size on disk">{facts?.sizeBytes === undefined ? '—' : formatBytes(facts.sizeBytes)}</Fact>
          <Fact label="Last modified">{facts?.lastModified ? formatTime(facts.lastModified) : '—'}</Fact>
          <Fact label="Partition columns">{facts ? facts.partitionColumns.join(', ') || 'None' : '…'}</Fact>
          {facts?.version !== undefined && <Fact label="Delta version">{facts.version}</Fact>}
        </dl>
      </header>

      <DatasetBar dataset={dataset} pinned={pinned} facts={facts} asOf={overview.asOf} onChange={setDataset} onSaveView={saveView} />

      <form
        className="compare-with"
        onSubmit={(e) => {
          e.preventDefault();
          if (compareTable) compareWith({ profile: dataset.profile, table: compareTable });
        }}
      >
        <label htmlFor="compare-table">Compare with</label>
        <input
          id="compare-table"
          type="text"
          spellCheck={false}
          placeholder="catalog.schema.table"
          value={compareDraft}
          aria-invalid={compareDraft.trim() !== '' && !compareTable}
          onChange={(e) => setCompareDraft(e.target.value)}
        />
        <button type="submit" disabled={!compareTable}>
          Compare
        </button>
        <button type="button" title="Compare this table with itself. Then give dataset B a different filter or version." onClick={() => compareWith({ profile: dataset.profile, table: dataset.table })}>
          Compare with this table
        </button>
      </form>

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
                onChange={setCard(card.column)}
                onClose={closeCard(card.column)}
                onFilter={addFilter}
              />
            );
          })}
        </div>
      )}

      {toolbar(rows.length, columns?.length, 'columns')}
      <OverviewTable dataset={pinned} rows={rows} overview={overview} open={open} onOpen={(column) => setCards((list) => openCard(list, column))} />
    </main>
  );
}
