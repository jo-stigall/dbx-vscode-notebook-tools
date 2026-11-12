/**
 * Build the table visualization feature with esbuild.
 *
 * Usage:
 *     npm run build
 *
 * The script writes these files:
 *
 *     dist/tableViz/host.js       the code that runs in the extension host
 *     dist/tableViz/webview.js    the code that runs in the webview
 *     dist/tableViz/webview.css   the styles of the webview
 *     dist/harness/               a test page that shows the webview in a browser, with demo data
 *
 * The rest of the extension (extension.js and src/*.js) needs no build.
 */
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, logLevel: 'info', legalComments: 'none' };

// The extension host. `vscode` is not a package: VS Code supplies it when the extension runs.
await esbuild.build({
  ...common,
  entryPoints: ['src/tableViz/host/index.ts'],
  outfile: 'dist/tableViz/host.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
});

// The webview. One script and one style sheet, because the Content Security Policy permits no other code.
const browser = {
  ...common,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  // The new JSX form of React 17 and later. Without it, each .tsx file must import React.
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
};
await esbuild.build({ ...browser, entryPoints: { webview: 'src/tableViz/webview/main.tsx' }, outdir: 'dist/tableViz' });

// The test page. The installed extension does not contain it.
await esbuild.build({ ...browser, entryPoints: { harness: 'test/tableViz/harness/harness.ts' }, outdir: 'dist/harness' });
mkdirSync('dist/harness', { recursive: true });
cpSync('test/tableViz/harness/index.html', 'dist/harness/index.html');
cpSync('test/tableViz/harness/themes.css', 'dist/harness/themes.css');
