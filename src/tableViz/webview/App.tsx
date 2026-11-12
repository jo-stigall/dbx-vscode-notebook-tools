/** The top of the page: wait for the datasets and the settings from the host, then show the board. */
import { useEffect, useState } from 'react';
import { Board } from './Board.tsx';
import { ConfirmView } from './ConfirmView.tsx';
import { send, start, type Init } from './rpc.ts';

/**
 * The component at the top of the page.
 *
 * What the user sees:
 *
 * 1. "Loading…" until the host sends the datasets and the settings.
 * 2. For a saved view that the extension did not see before: the page that
 *    shows its datasets and filters and asks for permission (ConfirmView).
 *    A click on "Run the Queries" tells the host, and the host sends the
 *    datasets again without the question.
 * 3. The board.
 *
 * @example
 * createRoot(document.getElementById('root')).render(<App />);
 */
export function App() {
  const [init, setInit] = useState<Init>();

  // One time: tell the host that the page started. The host answers with the datasets and the settings.
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
