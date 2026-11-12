/**
 * The test page: the webview of a board in a normal browser, with demo data.
 *
 * Build it with `npm run build`, then open dist/harness/index.html through a
 * local web server. See test/README.md, section "See a board in a browser".
 *
 *     npm run build
 *     python3 -m http.server 8791 --bind 127.0.0.1 --directory dist/harness
 *     # then open http://localhost:8791/index.html?theme=light&cards=amount
 *
 * The build makes dist/harness/harness.js from this file. index.html loads
 * that file. shim.ts lists the parameters of the page URL.
 *
 * The first import must be the shim: it defines `acquireVsCodeApi` before the
 * webview code asks for it.
 */
import './shim.ts';
import '../../../src/tableViz/webview/main.tsx';
