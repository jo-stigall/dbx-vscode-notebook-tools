/**
 * Build the table visualization feature ("Visualize Table") with esbuild.
 *
 * Usage, in the folder of the repository:
 *     npm run build
 *
 * `npm run test:unit`, `npm run test:e2e` and `npm run package` run this
 * script first, so you do not need to run it before them.
 *
 * The script writes these files:
 *
 *     dist/tableViz/host.js          the code that runs in the extension host
 *     dist/tableViz/driver.js        the Databricks SQL driver, which the host loads only for a cluster
 *     dist/tableViz/webview.js       the code that runs in the webview
 *     dist/tableViz/webview.css      the styles of the webview
 *     dist/tableViz/codicon.ttf      the icon font that the styles use
 *     dist/test/cards.test.cjs       the tests of the webview components, as a file that Node.js can run
 *     dist/test/fakeWorkspace.cjs    the fake Databricks workspace, for the test of the full extension
 *     dist/harness/                  a test page that shows the webview in a browser, with demo data:
 *                                    harness.js, harness.css, codicon.ttf, index.html and themes.css
 *
 * The script runs six builds, one after the other. If a build fails,
 * esbuild prints the error and the script stops.
 *
 * The rest of the extension (extension.js and src/*.js) needs no build.
 */
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

/**
 * The options that all builds share.
 *
 * - `bundle`: put the file and all files that it imports into one file.
 * - `logLevel: 'info'`: print the name and the size of each file that the build writes.
 * - `legalComments: 'none'`: do not copy the license comments of the packages into the file.
 *
 * @type {import('esbuild').BuildOptions}
 */
const common = { bundle: true, logLevel: 'info', legalComments: 'none' };

// Build 1 of 6: the extension host. `vscode` is not a package: VS Code supplies it when the extension runs.
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

// Build 2 of 6: the SQL driver for clusters, as its own file. Its two optional parts with native code are not in the file:
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

/**
 * The options for code that runs in a browser: the webview (build 3) and the test page (build 6).
 *
 * Each of the two builds writes one script, one style sheet and the icon font.
 *
 * @type {import('esbuild').BuildOptions}
 */
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
// Build 3 of 6: the webview. One script and one style sheet, because the Content Security Policy permits no other code.
await esbuild.build({ ...browser, entryPoints: { webview: 'src/tableViz/webview/main.tsx' }, outdir: 'dist/tableViz' });

// Build 4 of 6: the tests of the webview components. Node.js cannot run .tsx files, so esbuild converts them.
// The tests read only the HTML of the components, so the styles and the icon font become empty files (`loader`).
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

// Build 5 of 6: the fake Databricks workspace, for the test of the full extension in VS Code (test/tableViz/integration).
await esbuild.build({
  ...common,
  entryPoints: ['test/tableViz/fake/workspace.ts'],
  outfile: 'dist/test/fakeWorkspace.cjs',
  platform: 'node',
  format: 'cjs',
});

// Build 6 of 6: the test page. The installed extension does not contain it.
await esbuild.build({ ...browser, entryPoints: { harness: 'test/tableViz/harness/harness.ts' }, outdir: 'dist/harness' });
// Copy the two files of the test page that need no build.
mkdirSync('dist/harness', { recursive: true });
cpSync('test/tableViz/harness/index.html', 'dist/harness/index.html');
cpSync('test/tableViz/harness/themes.css', 'dist/harness/themes.css');
