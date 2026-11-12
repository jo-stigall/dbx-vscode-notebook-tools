/**
 * Build the table visualization feature with esbuild.
 *
 * Usage:
 *     npm run build
 *
 * The script writes these files:
 *
 *     dist/tableViz/host.js       the code that runs in the extension host
 *     dist/tableViz/driver.js     the Databricks SQL driver, which the host loads only for a cluster
 *     dist/tableViz/webview.js    the code that runs in the webview
 *     dist/tableViz/webview.css   the styles of the webview
 *     dist/harness/               a test page that shows the webview in a browser, with demo data
 *     dist/test/                  the tests of the webview components, as files that Node.js can run
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
  // './driver.js' is the next file. The host loads it only when the user selects a cluster.
  external: ['vscode', './driver.js'],
});

// The SQL driver for clusters, as its own file. Its two optional parts with native code are not in the file:
// the feature turns LZ4 compression off and never uses the "kernel" path.
await esbuild.build({
  ...common,
  entryPoints: ['src/tableViz/host/driver.ts'],
  outfile: 'dist/tableViz/driver.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  external: ['lz4-napi', '@databricks/databricks-sql-kernel-*'],
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
  // The icon font of @vscode/codicons becomes a file next to the style sheet.
  loader: { '.ttf': 'file' },
  assetNames: '[name]',
  define: { 'process.env.NODE_ENV': '"production"' },
};
await esbuild.build({ ...browser, entryPoints: { webview: 'src/tableViz/webview/main.tsx' }, outdir: 'dist/tableViz' });

// The tests of the webview components. Node.js cannot run .tsx files, so esbuild converts them.
await esbuild.build({
  ...common,
  entryPoints: ['test/tableViz/webview/cards.test.tsx'],
  outdir: 'dist/test',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  // react-dom/server is a CommonJS package that loads Node.js modules with require().
  format: 'cjs',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'empty', '.ttf': 'empty' },
});

// The fake Databricks workspace, for the test of the full extension in VS Code (test/tableViz/integration).
await esbuild.build({
  ...common,
  entryPoints: ['test/tableViz/fake/workspace.ts'],
  outfile: 'dist/test/fakeWorkspace.cjs',
  platform: 'node',
  format: 'cjs',
});

// The test page. The installed extension does not contain it.
await esbuild.build({ ...browser, entryPoints: { harness: 'test/tableViz/harness/harness.ts' }, outdir: 'dist/harness' });
mkdirSync('dist/harness', { recursive: true });
cpSync('test/tableViz/harness/index.html', 'dist/harness/index.html');
cpSync('test/tableViz/harness/themes.css', 'dist/harness/themes.css');
