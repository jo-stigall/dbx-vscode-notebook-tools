/** The top of the page: wait for the datasets and the settings from the host, then show the board. */
import { useEffect, useState } from 'react';
import type { BoardDatasets, BoardSettings } from '../core/schema.ts';
import { Board } from './Board.tsx';
import { start } from './rpc.ts';

export function App() {
  const [init, setInit] = useState<{ datasets: BoardDatasets; settings: BoardSettings }>();

  useEffect(() => {
    start((datasets, settings) => setInit({ datasets, settings }));
  }, []);

  if (!init) {
    return (
      <p className="status" role="status">
        Loading…
      </p>
    );
  }
  return <Board datasets={init.datasets} settings={init.settings} />;
}
