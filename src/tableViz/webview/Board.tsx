/**
 * The board: the facts of the table, the detail cards, and the overview of all columns.
 *
 * A click on a column name opens its detail card. A new card replaces the
 * cards that are not pinned. A pinned card stays, so that several columns
 * can sit side by side.
 *
 * The board holds the state of the page: the datasets, the open cards, the
 * search text and the sort. It gives them to the other components, and it
 * stores them after each change so that they come back after a window
 * reload. With a dataset B, the board is in compare mode and shows the
 * components in compare/.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addChip, mustAskBeforeScan, openCard } from '../core/derive.ts';
import { matchColumns } from '../core/match.ts';
import { displayTableName, parseTableName } from '../core/names.ts';
import type { BoardDatasets, BoardSettings, BoardState, Card, Chip, Dataset } from '../core/schema.ts';
import { ErrorPanel } from './cards/CardShell.tsx';
import { ColumnCard } from './cards/ColumnCard.tsx';
import { CompareCard } from './compare/CompareCard.tsx';
import { CompareTable, compareRows, SchemaPanel } from './compare/CompareOverview.tsx';
import { useDrifts } from './compare/useCompare.ts';
import { compareContext, CopyTableButton, tableContext, useBodyContext } from './CopyTable.tsx';
import { DatasetBar } from './DatasetBar.tsx';
import { formatBytes, formatCount, formatTime } from './format.ts';
import { useResult } from './hooks.ts';
import { EMPTY_OVERVIEW, OverviewTable, overviewRows, useOverview, type Sort } from './Overview.tsx';
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

/**
 * Tell if two datasets read the same table with the same login.
 *
 * The filter, the chips, the sample and the version can be different.
 *
 * @example
 * sameTable(orders, { ...orders, filter: "region = 'EMEA'" })   // true
 */
const sameTable = (x: Dataset, y: Dataset) => x.profile === y.profile && JSON.stringify(x.table) === JSON.stringify(y.table);

/**
 * The question before the first scan of a very large table.
 *
 * The user sees the size of the table and two buttons: "Use a 1% sample"
 * and "Read all rows". The board sends no query that reads the rows until
 * the user clicks one of them or types a filter.
 *
 * @example
 * <LargeTableNotice label="B" sizeBytes={500 * 1024 ** 3} onSample={...} onReadAll={...} />
 * // "Dataset B is 500.0 GB. A query that reads all rows can take a long time and cost money."
 *
 * @param label  'A' or 'B' in compare mode. Omit it for a board with one table.
 * @param sizeBytes  The size of the table on disk.
 * @param onSample  The user chose a 1% sample.
 * @param onReadAll  The user chose to read all rows.
 */
export function LargeTableNotice({ label, sizeBytes, onSample, onReadAll }: { label?: 'A' | 'B'; sizeBytes: number; onSample: () => void; onReadAll: () => void }) {
  return (
    <div className="notice" role="alert">
      <p>
        <strong>
          {label ? `Dataset ${label}` : 'This table'} is {formatBytes(sizeBytes)}.
        </strong>{' '}
        A query that reads all rows can take a long time and cost money.
      </p>
      <p>
        <button type="button" onClick={onSample}>
          Use a 1% sample
        </button>{' '}
        <button type="button" onClick={onReadAll}>
          Read all rows
        </button>{' '}
        You can also type a filter.
      </p>
    </div>
  );
}

/**
 * One fact in the header of the board: a small label and its value below it.
 *
 * @example
 * <Fact label="Rows">110,000</Fact>
 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The board of one table, or of two datasets in compare mode.
 *
 * From top to bottom, the user sees: the name and the facts of the table,
 * the bar with the filter and the sample of each dataset, the open detail
 * cards, and the overview with one row for each column.
 *
 * What the board does when the user acts:
 *
 * - A click on a row of the overview opens the detailed view of that column
 *   and moves the page to its card.
 * - A new filter, sample or version changes the dataset. All components
 *   then ask for their numbers again, and show the old numbers dimmed until
 *   the new numbers arrive.
 * - A click on a bar of a chart adds a filter chip to the dataset. In
 *   compare mode the chip goes to dataset A and to dataset B.
 * - "Compare" puts a second table on the board as dataset B. "Remove" on
 *   the bar of B goes back to one table.
 * - Text in the search box and the selection in "Sort by" change the rows of
 *   the overview. They send no request.
 *
 * The board reads the Delta version of each table together with the details
 * of the table, and puts that version in each request. All cards then show
 * the same data, also while a job writes to the table.
 *
 * @example
 * <Board datasets={{ a: { profile: 'Demo', table: { catalog: 'main', schema: 'shop', name: 'orders' } } }} settings={DEFAULT_SETTINGS} />
 *
 * @param datasets  Dataset A, and dataset B to start in compare mode.
 * @param settings  The settings of the feature, from the VS Code settings.
 * @param initialState  The cards and settings of a saved view. Not set: the board uses the state that the page stored before a window reload, if there is one.
 */
export function Board({ datasets: initial, settings, initialState }: { datasets: BoardDatasets; settings: BoardSettings; initialState?: BoardState }) {
  // The cards and settings: from a saved view, or from the state that the page stored before a window reload.
  const saved = useMemo(() => initialState ?? loadState(), [initialState]);
  // The user can change the filter and the sample of the dataset. The table and the profile do not change.
  const [dataset, setDataset] = useState<Dataset>(initial.a);
  // Dataset B is set in compare mode only. The user can add it and remove it.
  const [datasetB, setDatasetB] = useState<Dataset | undefined>(initial.b);
  const datasets = useMemo<BoardDatasets>(() => ({ a: dataset, ...(datasetB ? { b: datasetB } : {}) }), [dataset, datasetB]);

  // While the details load again (after a new filter or "Refresh"), the board keeps the details that it had.
  // The columns and the cards then stay on the screen. Details of a different table are never used.
  const details = useResult({ type: 'tableDetails', dataset });
  const facts = details.status === 'done' && sameTable(details.request.dataset, dataset) ? details.result : undefined;
  const columns = facts?.columns;

  // All queries read the Delta version that the table had when the board read its details.
  // The cards then show the same data, also while a job writes to the table.
  const version = facts?.version;
  const pinned = useMemo<Dataset>(() => (version && !dataset.version ? { ...dataset, version: { kind: 'version', n: version } } : dataset), [dataset, version]);

  // Before the first scan of a very large table, ask. A filter or a sample makes the scan small, so then there is no question.
  const [scanLarge, setScanLarge] = useState(saved?.scanLarge ?? false);
  const tooLarge = mustAskBeforeScan(facts?.sizeBytes, dataset, settings.largeTableBytes, scanLarge);
  const overview = useOverview(pinned, tooLarge ? undefined : columns);

  // Compare mode: the same steps for dataset B. Each request names one dataset, so the answers for A stay when B changes.
  const detailsB = useResult(datasetB ? { type: 'tableDetails', dataset: datasetB } : undefined);
  const factsB = datasetB && detailsB.status === 'done' && sameTable(detailsB.request.dataset, datasetB) ? detailsB.result : undefined;
  const versionB = factsB?.version;
  const pinnedB = useMemo<Dataset | undefined>(
    () => (datasetB && versionB && !datasetB.version ? { ...datasetB, version: { kind: 'version', n: versionB } } : datasetB),
    [datasetB, versionB]
  );
  // Dataset B has its own question: A can be small and B very large.
  const [scanLargeB, setScanLargeB] = useState(saved?.scanLargeB ?? false);
  const tooLargeB = datasetB !== undefined && mustAskBeforeScan(factsB?.sizeBytes, datasetB, settings.largeTableBytes, scanLargeB);
  const overviewB = useOverview(pinnedB ?? pinned, pinnedB && !tooLargeB ? factsB?.columns : undefined);
  const schema = useMemo(
    () => (columns && factsB ? matchColumns(columns, factsB.columns, { caseSensitive: settings.matchColumnsCaseSensitive }) : undefined),
    [columns, factsB, settings.matchColumnsCaseSensitive]
  );
  // The names of the columns of A whose types differ in B, and that the user chose to compare as text.
  const [asText, setAsText] = useState<string[]>(saved?.asText ?? []);
  // The drift of the new datasets comes from the new numbers only, not from old numbers that are still on the screen.
  const drifts = useDrifts(pinned, pinnedB ?? pinned, schema?.pairs ?? [], overview.stale ? EMPTY_OVERVIEW : overview, overviewB.stale ? EMPTY_OVERVIEW : overviewB, asText);

  const [search, setSearch] = useState(saved?.ui?.search ?? '');
  // In compare mode, the columns that changed most come first.
  const [sort, setSort] = useState<Sort>(saved?.ui?.sort ?? (initial.b ? 'drift' : 'table'));
  const [cards, setCards] = useState<Card[]>(saved?.cards ?? []);
  const state = useMemo<BoardState>(
    () => ({ datasets, ui: { search, sort }, cards, scanLarge, ...(scanLargeB ? { scanLargeB } : {}), asText }),
    [datasets, search, sort, cards, scanLarge, scanLargeB, asText]
  );
  useEffect(() => saveState(state), [state]);
  /** Write the board to a `.tableviz.json` file. The host asks for the file. */
  const saveView = () => send({ type: 'saveView', state });

  /** Put a table on the board as dataset B, or remove dataset B. */
  const compareWith = (next: Dataset | undefined) => {
    setDatasetB(next);
    // "Read all rows" was for the table that B was. A new table B gets its own question.
    setScanLargeB(false);
    setSort(next ? 'drift' : 'table');
  };
  // The text in the "Compare with" box, and the table name that it gives. undefined if the text is not a name with three parts.
  const [compareDraft, setCompareDraft] = useState('');
  const compareTable = parseTableName(compareDraft);

  const rows = useMemo(() => (columns ? overviewRows(columns, overview, search, sort) : []), [columns, overview, search, sort]);
  const pairRows = useMemo(() => (schema ? compareRows(schema, overview, overviewB, drifts, search, sort) : []), [schema, overview, overviewB, drifts, search, sort]);
  const open = useMemo(() => new Set(cards.map((c) => c.column)), [cards]);

  // When the user opens a column, move the page to its card. `n` changes at each click, so a second click on the same column also moves the page.
  const cardsElement = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<{ column: string; n: number }>();
  const openColumn = (column: string) => {
    setCards((list) => openCard(list, column));
    setOpened((prev) => ({ column, n: (prev?.n ?? 0) + 1 }));
  };
  useEffect(() => {
    if (!opened) return;
    const card = Array.from(cardsElement.current?.querySelectorAll<HTMLElement>('[data-card]') ?? []).find((el) => el.dataset.card === opened.column);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    card?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [opened]);

  const name = displayTableName(dataset.table);
  const nameB = datasetB && pinnedB ? displayTableName(datasetB.table) : undefined;
  const boardContext = details.status === 'error' || !nameB ? tableContext(name) : compareContext(name, nameB);
  useBodyContext(boardContext);
  if (details.status === 'error') {
    return (
      <main data-vscode-context={boardContext}>
        <h1>
          {name}
          <CopyTableButton name={name} />
        </h1>
        <ErrorPanel error={details.error} />
      </main>
    );
  }
  const sample = dataset.sample?.percent;
  /** Make the function that changes settings of the card of one column. Example: setCard('amount')({ logScale: true }). */
  const setCard =(column: string) => (patch: Partial<Card>) => setCards((list) => list.map((c) => (c.column === column ? { ...c, ...patch } : c)));
  /** Make the function that removes the card of one column from the board. */
  const closeCard = (column: string) => () => setCards((list) => list.filter((c) => c.column !== column));
  // A click on a bar adds a filter chip to the dataset. All cards then ask for their numbers again.
  const addFilter = (chip: Chip) => setDataset((d) => addChip(d, chip));
  /**
   * The line above the overview: the search box, the "Sort by" list, and a count such as "12 of 40 columns".
   *
   * @param shown  The number of rows that the overview shows after the search.
   * @param total  The number of all columns. undefined while the columns load.
   * @param what  The words after the numbers. Example: 'columns'.
   */
  const toolbar =(shown: number, total: number | undefined, what: string) => (
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

  if (datasetB && pinnedB && nameB) {
    const difference = overview.rowCount !== undefined && overviewB.rowCount !== undefined ? overviewB.rowCount - overview.rowCount : undefined;
    return (
      <main data-vscode-context={boardContext}>
        <header className="board-header">
          <h1>
            <span data-vscode-context={tableContext(name)}>
              <span className="chip chip-a">A</span> {name}
              <CopyTableButton name={name} />
            </span>{' '}
            <span className="versus">compared with</span>{' '}
            <span data-vscode-context={tableContext(nameB)}>
              <span className="chip chip-b">B</span> {nameB}
              <CopyTableButton name={nameB} />
            </span>{' '}
            <span className="badge">{profileLabel(dataset.profile)}</span>
          </h1>
          <dl className="facts">
            <Fact label="Rows in A">{overview.rowCount === undefined ? (tooLarge ? '—' : '…') : formatCount(overview.rowCount)}</Fact>
            <Fact label="Rows in B">{overviewB.rowCount === undefined ? (tooLargeB ? '—' : '…') : formatCount(overviewB.rowCount)}</Fact>
            <Fact label="Difference (B − A)">
              {difference === undefined
                ? '…'
                : `${difference > 0 ? '+' : ''}${formatCount(difference)}${overview.rowCount ? ` (${difference > 0 ? '+' : ''}${((difference / overview.rowCount) * 100).toFixed(1)}%)` : ''}`}
            </Fact>
          </dl>
        </header>

        <DatasetBar label="A" dataset={dataset} pinned={pinned} facts={facts} asOf={overview.asOf} onChange={setDataset} onSaveView={saveView} />
        <DatasetBar label="B" dataset={datasetB} pinned={pinnedB} facts={factsB} asOf={overviewB.asOf} onChange={setDatasetB} onRemove={() => compareWith(undefined)} hideActions />

        {tooLarge && <LargeTableNotice label="A" sizeBytes={facts?.sizeBytes ?? 0} onSample={() => setDataset({ ...dataset, sample: { percent: 1 } })} onReadAll={() => setScanLarge(true)} />}
        {tooLargeB && <LargeTableNotice label="B" sizeBytes={factsB?.sizeBytes ?? 0} onSample={() => setDatasetB({ ...datasetB, sample: { percent: 1 } })} onReadAll={() => setScanLargeB(true)} />}
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
                  overviewStale={overview.stale === true || overviewB.stale === true}
                  overviewStopped={Boolean(overview.error || overview.cancelled || overviewB.error || overviewB.cancelled)}
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
        <CompareTable rows={pairRows} a={overview} b={overviewB} open={open} onOpen={openColumn} />
      </main>
    );
  }

  return (
    <main data-vscode-context={boardContext}>
      <header className="board-header">
        <h1>
          {name}
          <CopyTableButton name={name} /> <span className="badge">{profileLabel(dataset.profile)}</span>
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

      {tooLarge && <LargeTableNotice sizeBytes={facts?.sizeBytes ?? 0} onSample={() => setDataset({ ...dataset, sample: { percent: 1 } })} onReadAll={() => setScanLarge(true)} />}

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
                overviewStale={overview.stale}
                overviewStopped={Boolean(overview.error || overview.cancelled)}
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
      <OverviewTable dataset={pinned} rows={rows} overview={overview} open={open} onOpen={openColumn} />
    </main>
  );
}
