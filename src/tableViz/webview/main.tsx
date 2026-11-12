/** The start of the webview: draw the board in the page. */
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
