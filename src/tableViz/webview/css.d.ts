/**
 * Tell TypeScript that a file can import a .css file.
 *
 * The import gives no value. esbuild puts the styles of an imported .css
 * file in dist/tableViz/webview.css.
 *
 * @example
 * import './styles.css';   // in main.tsx
 */
declare module "*.css";
