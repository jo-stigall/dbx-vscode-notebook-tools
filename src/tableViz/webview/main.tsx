/**
 * The start of the webview: draw the board in the page.
 *
 * esbuild makes dist/tableViz/webview.js from this file and all files that
 * it imports. The host puts that script in the HTML page of the webview,
 * which has an empty element with the id "root".
 */
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
