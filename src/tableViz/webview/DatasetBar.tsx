/**
 * The controls of a dataset: the filter, the sample, "Refresh" and "Cancel".
 *
 * The filter is the only SQL that the user types. Before the board uses a
 * filter, it asks Databricks to check it, and it shows the error from
 * Databricks below the controls.
 *
 * The bar does not hold the dataset. It calls `onChange` with a new
 * dataset, and the board (Board.tsx) keeps it.
 */
import { useEffect, useState } from 'react';
import { chipLabel, missesPartition, parseVersion, removeChip } from '../core/derive.ts';
import { displayTableName } from '../core/names.ts';
import type { Dataset, ResultOf } from '../core/schema.ts';
import { formatTime } from './format.ts';
import { acquire, cancelAll, refreshAll, release, useRequests, type RequestError } from './rpc.ts';

/** The properties of the `DatasetBar` component. */
export interface DatasetBarProps {
  /** The dataset that the bar shows and changes: its filter, chips, sample and version. */
  dataset: Dataset;
  /** The dataset with the Delta version that the board reads. The filter check uses it. */
  pinned: Dataset;
  /** The details of the table. Not set while they load. The bar reads the partition columns from it. */
  facts: ResultOf<'tableDetails'> | undefined;
  /** The time of the first query, as ISO 8601 text. The bar shows it for a table that has no Delta version. */
  asOf: string | undefined;
  /** The user changed the filter, a chip, the sample or the version. The function gets the new dataset. */
  onChange: (dataset: Dataset) => void;
  /** Compare mode: 'A' or 'B'. The bar then shows the letter and the name of the table. */
  label?: 'A' | 'B';
  /** Compare mode, dataset B: removes dataset B from the board. */
  onRemove?: () => void;
  /** Hide "Refresh" and "Cancel". In compare mode only the bar of A shows them. */
  hideActions?: boolean;
  /** Writes the board to a file. If set, the bar has the button "Save View". */
  onSaveView?: () => void;
}

/**
 * The bar with the controls of one dataset.
 *
 * What the user sees and what the bar does:
 *
 * - The "Filter" box. "Apply" (or the Enter key) sends a "validateFilter"
 *   request. If Databricks accepts the filter, the bar calls `onChange` with
 *   the new filter. If not, the bar shows the error and the dataset stays
 *   as it was. "Clear" removes the filter.
 * - One chip for each filter from a click on a chart. The "x" on a chip
 *   removes that chip.
 * - The "Sample" check box and its percent, from 0.01 to 100. A percent
 *   outside this range removes the sample.
 * - The "Version" box. The bar uses the text when the user presses Enter or
 *   leaves the box. Text that is not a version number or a time gets the
 *   border color of an error, and the dataset stays as it was.
 * - "Cancel 3 queries" while requests run, "Save View", and "Refresh".
 * - A hint, if the table has partition columns and the filter uses none of
 *   them.
 *
 * @example
 * <DatasetBar dataset={dataset} pinned={pinned} facts={facts} asOf={overview.asOf} onChange={setDataset} onSaveView={saveView} />
 */
export function DatasetBar({ dataset, pinned, facts, asOf, onChange, label, onRemove, hideActions, onSaveView }: DatasetBarProps) {
  const { pending } = useRequests();
  const [draft, setDraft] = useState(dataset.filter ?? '');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<RequestError>();
  const [percent, setPercent] = useState(String(dataset.sample?.percent ?? 10));
  const versionText = dataset.version?.kind === 'version' ? dataset.version.n : (dataset.version?.ts ?? '');
  const [versionDraft, setVersionDraft] = useState(versionText);
  useEffect(() => setDraft(dataset.filter ?? ''), [dataset.filter]);
  useEffect(() => setVersionDraft(versionText), [versionText]);
  const versionValid = parseVersion(versionDraft) !== 'invalid';
  const id = `filter-${label ?? 'a'}`;

  /** Use the text of the "Version" box: a Delta version number, or a date and time. Empty means the newest version. */
  const applyVersion = () => {
    const version = parseVersion(versionDraft);
    if (version === 'invalid' || versionDraft.trim() === versionText) return;
    onChange({ ...dataset, version });
  };

  /** Use the text in the box as the filter, if Databricks can read it. */
  const apply = async () => {
    const filter = draft.trim();
    setError(undefined);
    if (filter === (dataset.filter ?? '')) return;
    if (!filter) {
      onChange({ ...dataset, filter: undefined });
      return;
    }
    const request = { type: 'validateFilter' as const, dataset: { ...pinned, filter } };
    setChecking(true);
    try {
      await acquire(request);
      onChange({ ...dataset, filter });
    } catch (e) {
      const failure = e as RequestError;
      if (!failure.cancelled) setError(failure);
    } finally {
      release(request);
      setChecking(false);
    }
  };

  /**
   * Use the "Sample" check box and the text of the percent box.
   *
   * @param on  true if the check box has a check mark.
   * @param text  The percent as text. If it is not a number from 0.01 to 100, the dataset gets no sample.
   */
  const setSample = (on: boolean, text: string) => {
    const value = Number(text);
    const valid = Number.isFinite(value) && value >= 0.01 && value <= 100;
    onChange({ ...dataset, sample: on && valid ? { percent: value } : undefined });
  };

  // Which data the board shows. Example: "Delta version 42", or "As of 1 Nov 2026, 02:05" for a table that has no Delta version.
  const snapshot = pinned.version?.kind === 'version' ? `Delta version ${pinned.version.n}` : asOf ? `As of ${formatTime(asOf)}` : undefined;

  return (
    <div className={`dataset-bar${label ? ` dataset-${label.toLowerCase()}` : ''}`}>
      {label && (
        <p className="dataset-name">
          <span className={`chip chip-${label.toLowerCase()}`}>{label}</span> {displayTableName(dataset.table)}
          {onRemove && (
            <button type="button" className="link" onClick={onRemove}>
              Remove
            </button>
          )}
        </p>
      )}
      <form
        className="filter"
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <label htmlFor={id}>Filter</label>
        <input
          id={id}
          type="text"
          spellCheck={false}
          placeholder="A SQL condition. Example: order_date >= '2026-01-01' AND region = 'EMEA'"
          value={draft}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={checking || draft.trim() === (dataset.filter ?? '')}>
          {checking ? 'Checking…' : 'Apply'}
        </button>
        {dataset.filter && (
          <button
            type="button"
            onClick={() => {
              setError(undefined);
              onChange({ ...dataset, filter: undefined });
            }}
          >
            Clear
          </button>
        )}
      </form>

      {dataset.chips && dataset.chips.length > 0 && (
        <ul className="chips" aria-label="Filters from clicks on charts">
          {dataset.chips.map((chip, i) => (
            <li key={JSON.stringify(chip)} className="filter-chip">
              {chipLabel(chip)}
              <button type="button" title="Remove this filter" aria-label={`Remove the filter ${chipLabel(chip)}`} onClick={() => onChange(removeChip(dataset, i))}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="dataset-controls">
        <label title="Read a part of the rows only. Faster and cheaper, but all counts are estimates.">
          <input type="checkbox" checked={dataset.sample !== undefined} onChange={(e) => setSample(e.target.checked, percent)} /> Sample
        </label>
        <label>
          <input
            type="number"
            className="percent"
            aria-label="Sample percent"
            min={0.01}
            max={100}
            step="any"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            onBlur={() => dataset.sample && setSample(true, percent)}
            onKeyDown={(e) => e.key === 'Enter' && dataset.sample && setSample(true, percent)}
          />{' '}
          %
        </label>
        <label title="A Delta version number, or a date and time such as 2026-11-01 02:05. Empty: the newest version.">
          Version{' '}
          <input
            type="text"
            className="version"
            placeholder="newest"
            value={versionDraft}
            aria-invalid={!versionValid}
            onChange={(e) => setVersionDraft(e.target.value)}
            onBlur={applyVersion}
            onKeyDown={(e) => e.key === 'Enter' && applyVersion()}
          />
        </label>
        <span className="spacer" />
        {snapshot && <span className="count">{snapshot}</span>}
        {!hideActions && pending > 0 && (
          <button type="button" onClick={cancelAll} title="Stop the queries that run now">
            Cancel {pending} {pending === 1 ? 'query' : 'queries'}
          </button>
        )}
        {onSaveView && (
          <button type="button" onClick={onSaveView} title="Write the datasets, the filters and the cards of this board to a .tableviz.json file. The file has no data.">
            Save View
          </button>
        )}
        {!hideActions && (
          <button type="button" onClick={refreshAll} title="Run all queries again and read the newest data">
            Refresh
          </button>
        )}
      </div>

      {error && (
        <div id={`${id}-error`} className="error" role="alert">
          <p className="error-message">{error.message}</p>
          {error.nextStep && <p>{error.nextStep}</p>}
          {error.raw !== error.message && <pre>{error.raw}</pre>}
        </div>
      )}
      {missesPartition(dataset.filter, facts?.partitionColumns ?? []) && (
        <p className="hint">
          The table is partitioned by {facts?.partitionColumns.join(', ')}, and the filter does not use {facts?.partitionColumns.length === 1 ? 'that column' : 'those columns'}. Each query
          reads all partitions.
        </p>
      )}
    </div>
  );
}
