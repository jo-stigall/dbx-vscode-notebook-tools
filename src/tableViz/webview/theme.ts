/**
 * Read the colors of the VS Code theme for the charts.
 *
 * The styles of the page use the --vscode-* variables directly. A chart is a
 * canvas, and a canvas cannot use a CSS variable, so this file reads the
 * values of the variables. The values change when the user selects a
 * different theme.
 */
import { useEffect, useMemo, useState } from 'react';

export interface Theme {
  foreground: string;
  muted: string;
  border: string;
  background: string;
  /** The color of dataset A. */
  a: string;
  /** The color of dataset B. */
  b: string;
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

/** Get the colors of the theme. The component draws again when the user changes the theme. */
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
