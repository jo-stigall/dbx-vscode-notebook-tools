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

function DatasetFacts({ label, dataset }: { label: string; dataset: Dataset }) {
  const version = dataset.version?.kind === 'version' ? `Delta version ${dataset.version.n}` : dataset.version?.ts;
  return (
    <section className="confirm-dataset" aria-label={`Dataset ${label}`}>
      <h2>
        Dataset {label}: {displayTableName(dataset.table)}
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

export function ConfirmView({ datasets, onApprove }: { datasets: BoardDatasets; onApprove: () => void }) {
  return (
    <main className="confirm">
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
