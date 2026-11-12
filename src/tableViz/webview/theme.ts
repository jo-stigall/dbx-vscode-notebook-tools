/**
 * Read the colors of the VS Code theme for the charts.
 *
 * The styles of the page use the --vscode-* variables directly. A chart is a
 * canvas, and a canvas cannot use a CSS variable, so this file reads the
 * values of the variables. The values change when the user selects a
 * different theme.
 */
import { useEffect, useMemo, useState } from 'react';

/**
 * The colors and the font that a chart uses. Each color is CSS text, for example '#3794ff'.
 *
 * options.ts puts these values in the settings of a chart.
 */
export interface Theme {
  /** The color of normal text: the labels on the bars and the text of the tooltip. From `--vscode-foreground`. */
  foreground: string;
  /** The color of less important text: the labels and the titles of the axes. From `--vscode-descriptionForeground`. */
  muted: string;
  /** The color of the lines of the axes and of the grid. From `--vscode-contrastBorder` in a high contrast theme, or `--vscode-panel-border`. */
  border: string;
  /** The color behind the tooltip: the background of the editor. From `--vscode-editor-background`. */
  background: string;
  /** The color of dataset A. From `--vscode-charts-blue`. */
  a: string;
  /** The color of dataset B. From `--vscode-charts-orange`. */
  b: string;
  /** The font family of the text in a chart. From `--vscode-font-family`. */
  font: string;
}

/** The colors for a place that has no page, for example a test that runs in Node.js. */
export const FALLBACK_THEME: Theme = {
  foreground: '#cccccc',
  muted: '#9d9d9d',
  border: '#444444',
  background: '#1f1f1f',
  a: '#3794ff',
  b: '#d18616',
  font: 'sans-serif',
};

/**
 * Read the values of the --vscode-* variables from the `<body>` element.
 *
 * If a variable has no value, the function uses the color of FALLBACK_THEME.
 * If there is no page, it returns FALLBACK_THEME.
 *
 * @example
 * readTheme().a   // the value of --vscode-charts-blue, for example '#3794ff'
 */
function readTheme(): Theme {
  if (typeof document === 'undefined') return FALLBACK_THEME;
  const style = getComputedStyle(document.body);
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    foreground: value('--vscode-foreground', FALLBACK_THEME.foreground),
    muted: value('--vscode-descriptionForeground', FALLBACK_THEME.muted),
    border: value('--vscode-contrastBorder', '') || value('--vscode-panel-border', FALLBACK_THEME.border),
    background: value('--vscode-editor-background', FALLBACK_THEME.background),
    a: value('--vscode-charts-blue', FALLBACK_THEME.a),
    b: value('--vscode-charts-orange', FALLBACK_THEME.b),
    font: value('--vscode-font-family', FALLBACK_THEME.font),
  };
}

/**
 * Get the colors of the theme. The component draws again when the user changes the theme.
 *
 * @example
 * const theme = useTheme();
 * const option = barsOption(theme, { labels, counts, tips });   // the bars have the color `theme.a`
 */
export function useTheme(): Theme {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    // VS Code changes the class and the attributes of <body> when the theme changes.
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.body, { attributes: true });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return useMemo(readTheme, [version]);
}
