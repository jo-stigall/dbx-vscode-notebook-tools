/** The top of the board: wait for the datasets from the host, then show the overview. */
import { useEffect, useState } from 'react';
import type { BoardDatasets } from '../core/schema.ts';
import { Overview } from './Overview.tsx';
import { loadState, saveState, start } from './rpc.ts';

export function App() {
  const [datasets, setDatasets] = useState<BoardDatasets>();

  useEffect(() => {
    start((fromHost) => {
      setDatasets(fromHost);
      // Store the datasets, so that VS Code can show the board again after a window reload.
      saveState({ datasets: fromHost, ui: loadState()?.ui });
    });
  }, []);

  if (!datasets) {
    return (
      <p className="status" role="status">
        Loading…
      </p>
    );
  }
  return <Overview datasets={datasets} />;
}
