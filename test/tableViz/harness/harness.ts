/**
 * The test page: the webview of a board in a normal browser, with demo data.
 *
 * Build it with `npm run build`, then open dist/harness/index.html through a
 * local web server. See test/README.md.
 *
 * The first import must be the shim: it defines `acquireVsCodeApi` before the
 * webview code asks for it.
 */
import './shim.ts';
import '../../../src/tableViz/webview/main.tsx';
