/** Make the ECharts settings for the bar charts of the cards. */
import type { ChartOption } from './Chart.tsx';
import { formatCount } from './format.ts';
import type { Theme } from './theme.ts';

/** Make text safe to put in the HTML of a tooltip. */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export interface BarsInput {
  /** The text below each bar (or next to each bar, if `horizontal`). */
  labels: string[];
  counts: number[];
  /** The text of the tooltip of each bar. Line breaks are permitted. */
  tips: string[];
  /** true: the count axis has a logarithmic scale. A bar with the count 0 does not show. */
  logScale?: boolean;
  /** true: the bars go from left to right, with the first bar at the top. Use it for category values, which have long labels. */
  horizontal?: boolean;
  /** The width of the space between two bars, as a percent of the bar width. 0 for a histogram. */
  gap?: number;
}

/**
 * Make the settings of a bar chart.
 *
 * @example
 * barsOption(theme, { labels: ['web', 'store'], counts: [60, 30], tips: ['web: 60 rows', 'store: 30 rows'], horizontal: true })
 */
export function barsOption(theme: Theme, input: BarsInput): ChartOption {
  const categoryAxis = {
    type: 'category' as const,
    data: input.labels,
    inverse: input.horizontal === true,
    axisLabel: { color: theme.muted, hideOverlap: true, width: input.horizontal ? 130 : undefined, overflow: 'truncate' as const },
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
  };
  const countAxis = {
    type: input.logScale ? ('log' as const) : ('value' as const),
    // On a logarithmic axis, start below 1 so that a bar with the count 1 has a height.
    min: input.logScale ? 0.5 : undefined,
    axisLabel: { color: theme.muted, formatter: (value: number) => (value < 1 ? '' : formatCount(value)) },
    splitLine: { lineStyle: { color: theme.border, opacity: 0.5 } },
  };
  return {
    animation: false,
    textStyle: { color: theme.foreground, fontFamily: theme.font },
    grid: { left: 4, right: 16, top: 12, bottom: 4, containLabel: true },
    // The card writes its own sentence for screen readers, and it can show the chart as a table. Do not let ECharts replace that sentence.
    aria: { enabled: true, label: { enabled: false } },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.foreground, fontFamily: theme.font, fontSize: 12 },
      // The formatter returns HTML that has no style attributes, because the Content Security Policy forbids them.
      formatter: (params: unknown) => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex: number };
        return escapeHtml(input.tips[first.dataIndex] ?? '').replace(/\n/g, '<br>');
      },
    },
    xAxis: input.horizontal ? countAxis : categoryAxis,
    yAxis: input.horizontal ? categoryAxis : countAxis,
    series: [
      {
        type: 'bar',
        // A logarithmic axis cannot show 0. null draws no bar.
        data: input.logScale ? input.counts.map((c) => (c > 0 ? c : null)) : input.counts,
        itemStyle: { color: theme.a },
        barCategoryGap: `${input.gap ?? 20}%`,
        emphasis: { itemStyle: { color: theme.a, opacity: 0.75 } },
      },
    ],
  };
}
