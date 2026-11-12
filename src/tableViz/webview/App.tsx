/** The top of the page: wait for the datasets and the settings from the host, then show the board. */
import { useEffect, useState } from 'react';
import { Board } from './Board.tsx';
import { ConfirmView } from './ConfirmView.tsx';
import { send, start, type Init } from './rpc.ts';

export function App() {
  const [init, setInit] = useState<Init>();

  useEffect(() => {
    start(setInit);
  }, []);

  if (!init) {
    return (
      <p className="status" role="status">
        Loading…
      </p>
    );
  }
  // A saved view that the extension did not see before: show its datasets and filters, and run nothing.
  if (init.confirm) return <ConfirmView datasets={init.datasets} onApprove={() => send({ type: 'approve' })} />;
  return <Board datasets={init.datasets} settings={init.settings} initialState={init.state} />;
}
