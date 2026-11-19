/**
 * The page that asks before a saved view runs its queries.
 *
 * A `.tableviz.json` file can come from a different person. Its filters are
 * SQL, and they run with the Databricks login of the person who opens the
 * file. Thus the page shows each dataset and each filter, and runs nothing
 * until the user clicks the button.
 */
import { chipLabel } from '../core/derive.ts';
import { displayTableName } from '../core/names.ts';
import type { BoardDatasets, Dataset } from '../core/schema.ts';
import { compareContext, CopyTableButton, tableContext, useBodyContext } from './CopyTable.tsx';

/**
 * What one dataset of a saved view reads: the table, the login, the filter,
 * the filters from charts, the version and the sample.
 *
 * The filter shows as the exact SQL text, so that the user can read it
 * before it runs.
 *
 * @example
 * <DatasetFacts label="A" dataset={{ profile: 'Demo', table: { catalog: 'main', schema: 'shop', name: 'orders' }, filter: "region = 'EMEA'" }} />
 * // Dataset A: main.shop.orders
 * // Login: Demo
 * // Filter (SQL): region = 'EMEA'
 * // Filters from charts: None
 * // Version: The newest version
 * // Sample: All rows
 *
 * @param label  'A' or 'B'.
 */
function DatasetFacts({ label, dataset }: { label: string; dataset: Dataset }) {
  const version = dataset.version?.kind === 'version' ? `Delta version ${dataset.version.n}` : dataset.version?.ts;
  const tableName = displayTableName(dataset.table);
  return (
    <section className="confirm-dataset" aria-label={`Dataset ${label}`} data-vscode-context={tableContext(tableName)}>
      <h2>
        Dataset {label}: {tableName}
        <CopyTableButton name={tableName} />
      </h2>
      <dl>
        <dt>Login</dt>
        <dd>{dataset.profile}</dd>
        <dt>Filter (SQL)</dt>
        <dd>{dataset.filter ? <pre>{dataset.filter}</pre> : 'None'}</dd>
        <dt>Filters from charts</dt>
        <dd>{dataset.chips?.length ? dataset.chips.map(chipLabel).join(' AND ') : 'None'}</dd>
        <dt>Version</dt>
        <dd>{version ?? 'The newest version'}</dd>
        <dt>Sample</dt>
        <dd>{dataset.sample ? `${dataset.sample.percent}% of the rows` : 'All rows'}</dd>
      </dl>
    </section>
  );
}

/**
 * The page that asks "Run the queries of this saved view?".
 *
 * The user sees the facts of dataset A (and of dataset B, if the view has
 * one) and the button "Run the Queries". The page sends no request. A click
 * on the button calls `onApprove`.
 *
 * @example
 * <ConfirmView datasets={init.datasets} onApprove={() => send({ type: 'approve' })} />
 *
 * @param datasets  The datasets of the saved view.
 * @param onApprove  The user permits the queries. App.tsx tells the host, and the host then starts the board.
 */
export function ConfirmView({ datasets, onApprove }: { datasets: BoardDatasets; onApprove: () => void }) {
  const nameA = displayTableName(datasets.a.table);
  const rootContext = datasets.b ? compareContext(nameA, displayTableName(datasets.b.table)) : tableContext(nameA);
  useBodyContext(rootContext);
  return (
    <main className="confirm" data-vscode-context={rootContext}>
      <h1>Run the queries of this saved view?</h1>
      <p>
        This view comes from a file. It reads the datasets below with your Databricks login. A filter is SQL that the file contains. Read each filter before you continue.
      </p>
      <DatasetFacts label="A" dataset={datasets.a} />
      {datasets.b && <DatasetFacts label="B" dataset={datasets.b} />}
      <p>
        <button type="button" className="primary" onClick={onApprove}>
          Run the Queries
        </button>
      </p>
      <p className="status">If you do not know where the file comes from, close this tab. No query ran.</p>
    </main>
  );
}
