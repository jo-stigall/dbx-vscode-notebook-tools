/**
 * The controls of a dataset: the filter, the sample, "Refresh" and "Cancel".
 *
 * The filter is the only SQL that the user types. Before the board uses a
 * filter, it asks Databricks to check it, and it shows the error from
 * Databricks next to the box.
 */
import { useEffect, useState } from 'react';
import { missesPartition } from '../core/derive.ts';
import type { Dataset, ResultOf } from '../core/schema.ts';
import { formatTime } from './format.ts';
import { acquire, cancelAll, refreshAll, release, useRequests, type RequestError } from './rpc.ts';

export interface DatasetBarProps {
  dataset: Dataset;
  /** The dataset with the Delta version that the board reads. The filter check uses it. */
  pinned: Dataset;
  /** The details of the table. Not set while they load. */
  facts: ResultOf<'tableDetails'> | undefined;
  /** The time of the first query, for a table that has no Delta version. */
  asOf: string | undefined;
  onChange: (dataset: Dataset) => void;
}

export function DatasetBar({ dataset, pinned, facts, asOf, onChange }: DatasetBarProps) {
  const { pending } = useRequests();
  const [draft, setDraft] = useState(dataset.filter ?? '');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<RequestError>();
  const [percent, setPercent] = useState(String(dataset.sample?.percent ?? 10));
  useEffect(() => setDraft(dataset.filter ?? ''), [dataset.filter]);

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

  const setSample = (on: boolean, text: string) => {
    const value = Number(text);
    const valid = Number.isFinite(value) && value >= 0.01 && value <= 100;
    onChange({ ...dataset, sample: on && valid ? { percent: value } : undefined });
  };

  const snapshot = pinned.version?.kind === 'version' ? `Delta version ${pinned.version.n}` : asOf ? `As of ${formatTime(asOf)}` : undefined;

  return (
    <div className="dataset-bar">
      <form
        className="filter"
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <label htmlFor="filter">Filter</label>
        <input
          id="filter"
          type="text"
          spellCheck={false}
          placeholder="A SQL condition. Example: order_date >= '2026-01-01' AND region = 'EMEA'"
          value={draft}
          aria-invalid={error !== undefined}
          aria-describedby={error ? 'filter-error' : undefined}
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
        <span className="spacer" />
        {snapshot && <span className="count">{snapshot}</span>}
        {pending > 0 && (
          <button type="button" onClick={cancelAll} title="Stop the queries that run now">
            Cancel {pending} {pending === 1 ? 'query' : 'queries'}
          </button>
        )}
        <button type="button" onClick={refreshAll} title="Run all queries again and read the newest data">
          Refresh
        </button>
      </div>

      {error && (
        <div id="filter-error" className="error" role="alert">
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
