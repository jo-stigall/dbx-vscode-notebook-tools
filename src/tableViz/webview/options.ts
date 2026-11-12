/**
 * Make the ECharts settings for the bar charts of the cards.
 *
 * The views in cards/views.tsx and compare/views.tsx call these functions
 * and give the settings to the `Chart` component in Chart.tsx. The functions
 * read nothing from the page and send no request, so a test can call them in
 * Node.js.
 */
import type { ChartOption } from './Chart.tsx';
import { formatCount, formatNumber } from './format.ts';
import type { Theme } from './theme.ts';

/**
 * Make text safe to put in the HTML of a tooltip.
 *
 * A value of a column can contain HTML. The tooltip must show it as text.
 *
 * @example
 * escapeHtml('<b>web</b>')   // '&#60;b&#62;web&#60;/b&#62;'
 */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** How long a chart takes to move from the old numbers to the new numbers, in milliseconds. */
const MOVE_MS = 280;

/** Tell if the user asked the operating system for less motion. A chart then changes at once. */
function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The extra parts of a chart in the detailed view of a column: titles on
 * the axes, a label on each bar, and for a histogram an axis of numbers
 * with lines for statistics such as the mean.
 */
export interface ChartDetail {
  /** The title of the axis that has the bars. Example: the name of the column. */
  categoryName?: string;
  /** The title of the count axis. Example: 'Rows'. */
  countName: string;
  /** The text on each bar. Example: '55,007 (50%)'. The chart hides a label that would cover a different label. */
  barLabels?: string[];
  /**
   * For a histogram: the range of numbers that the bars cover. The chart
   * then shows an axis of numbers below the bars, and one line for each
   * marker at its exact position.
   */
  numeric?: { lo: number; hi: number; markers: { value: number; label: string }[] };
}

/**
 * What barsOption() needs to draw the bars of one dataset.
 *
 * `labels`, `counts` and `tips` have one entry for each bar, in the sequence
 * of the bars.
 */
export interface BarsInput {
  /** The text below each bar (or next to each bar, if `horizontal`). */
  labels: string[];
  /** The length of each bar: a number of rows, or a percent of the rows in a compare card. */
  counts: number[];
  /** The text of the tooltip of each bar. The text can have line breaks. Example: '0 to 25\n60,352 rows (54.9%)'. */
  tips: string[];
  /** true: the count axis has a logarithmic scale. A bar with the count 0 does not show. */
  logScale?: boolean;
  /** true: the bars go from left to right, with the first bar at the top. Use it for category values, which have long labels. */
  horizontal?: boolean;
  /** The width of the space between two bars, as a percent of the bar width. 0 for a histogram. */
  gap?: number;
  /** The color of the bars. Default: the color of dataset A. */
  color?: string;
  /** The top of the count axis. Two charts side by side use the same number, so that you can compare the lengths of their bars. */
  max?: number;
  /** Writes a number of the count axis. Default: a count with separators. */
  axisFormat?: (value: number) => string;
  /** The extra parts of the chart in the detailed view of a column. Not set for a small card. */
  detail?: ChartDetail;
}

/**
 * Make the settings of a bar chart.
 *
 * Each part has a fixed id (`x`, `y`, `a`). When the numbers change, ECharts
 * then moves the bars of the old chart to their new heights. It does not
 * draw a new chart from zero.
 *
 * @example
 * // The top values of the column `channel`, most frequent first.
 * const option = barsOption(theme, { labels: ['web', 'store'], counts: [60, 30], tips: ['web: 60 rows', 'store: 30 rows'], horizontal: true });
 * option.series[0].data   // [60, 30]
 * option.yAxis.data       // ['web', 'store']: with `horizontal`, the labels are on the vertical axis
 *
 * @example
 * // A logarithmic axis cannot show 0. The bar with the count 0 gets null, and ECharts draws no bar.
 * const option = barsOption(theme, { labels: ['0', '10', '20'], counts: [120, 0, 45], tips: ['', '', ''], logScale: true, gap: 0 });
 * option.series[0].data   // [120, null, 45]
 *
 * @param theme  The colors and the font of the VS Code theme. See useTheme() in theme.ts.
 */
export function barsOption(theme: Theme, input: BarsInput): ChartOption {
  const { detail } = input;
  const numeric = detail?.numeric && !input.horizontal ? detail.numeric : undefined;
  const axisName = (name: string | undefined, gap: number) =>
    name ? { name, nameLocation: 'middle' as const, nameGap: gap, nameTextStyle: { color: theme.muted, fontFamily: theme.font } } : {};

  const categoryAxis = {
    id: 'x',
    type: 'category' as const,
    data: input.labels,
    inverse: input.horizontal === true,
    // With an axis of numbers below the bars, the bars need no labels of their own.
    axisLabel: { show: !numeric, color: theme.muted, hideOverlap: true, width: input.horizontal ? 130 : undefined, overflow: 'truncate' as const },
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
    // A title next to long value labels would need much space. The title of the card names the column.
    ...(numeric || input.horizontal ? {} : axisName(detail?.categoryName, 30)),
  };
  const countAxis = {
    id: 'y',
    type: input.logScale ? ('log' as const) : ('value' as const),
    // On a logarithmic axis, start below 1 so that a bar with the count 1 has a height.
    min: input.logScale ? 0.5 : undefined,
    max: input.max,
    axisLabel: { color: theme.muted, formatter: (value: number) => (input.logScale && value < 1 ? '' : (input.axisFormat ?? formatCount)(value)) },
    splitLine: { lineStyle: { color: theme.border, opacity: 0.5 } },
    ...axisName(detail?.countName, input.horizontal ? 28 : 56),
  };
  // The axis of numbers of a histogram. It covers the same width as the bars, so a number is at its exact place.
  const numberAxis = numeric && {
    id: 'x2',
    type: 'value' as const,
    min: numeric.lo,
    max: numeric.hi,
    position: 'bottom' as const,
    axisLabel: { color: theme.muted, formatter: (value: number) => formatNumber(value), hideOverlap: true },
    axisLine: { show: false },
    axisTick: { show: true, lineStyle: { color: theme.border } },
    splitLine: { show: false },
    axisPointer: { show: false },
    ...axisName(detail?.categoryName, 30),
  };
  const markers = numeric?.markers ?? [];
  const motion = !reducedMotion();

  return {
    animation: motion,
    animationDuration: MOVE_MS,
    animationDurationUpdate: MOVE_MS,
    animationEasingUpdate: 'cubicOut',
    textStyle: { color: theme.foreground, fontFamily: theme.font },
    grid: detail
      ? { left: input.horizontal ? 8 : 22, right: 28, top: 18 + markers.length * 13, bottom: input.horizontal || numeric || detail.categoryName ? 26 : 6, containLabel: true }
      : { left: 4, right: 16, top: 12, bottom: 4, containLabel: true },
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
    xAxis: input.horizontal ? countAxis : numberAxis ? [categoryAxis, numberAxis] : categoryAxis,
    yAxis: input.horizontal ? categoryAxis : countAxis,
    series: [
      {
        id: 'a',
        type: 'bar',
        // A logarithmic axis cannot show 0. null draws no bar.
        data: input.logScale ? input.counts.map((c) => (c > 0 ? c : null)) : input.counts,
        itemStyle: { color: input.color ?? theme.a },
        barCategoryGap: `${input.gap ?? 20}%`,
        emphasis: { itemStyle: { color: input.color ?? theme.a, opacity: 0.75 } },
        ...(detail?.barLabels
          ? {
              label: {
                show: true,
                position: input.horizontal ? ('right' as const) : ('top' as const),
                color: theme.foreground,
                fontSize: 11,
                formatter: (item: { dataIndex: number }) => detail.barLabels?.[item.dataIndex] ?? '',
              },
              labelLayout: { hideOverlap: true },
            }
          : {}),
      },
      // A series with no bars. It only holds the marker lines, on the axis of numbers.
      ...(numberAxis && markers.length
        ? [
            {
              id: 'markers',
              type: 'bar' as const,
              xAxisIndex: 1,
              data: [],
              silent: true,
              tooltip: { show: false },
              markLine: {
                symbol: 'none',
                silent: true,
                lineStyle: { color: theme.foreground, type: 'dashed' as const, width: 1 },
                data: markers.map((marker, i) => ({
                  xAxis: marker.value,
                  name: marker.label,
                  // Each label is a little higher than the one before it, so that two lines near each other have two labels.
                  label: { show: true, formatter: '{b}', position: 'end' as const, distance: 2 + i * 13, color: theme.foreground, fontSize: 11 },
                })),
              },
            },
          ]
        : []),
    ],
  };
}

/**
 * What compareBarsOption() needs to draw the bars of dataset A and dataset B in one chart.
 *
 * `labels`, `a`, `b` and `tips` have one entry for each label. Each label
 * gets one bar of A and one bar of B.
 */
export interface CompareBarsInput {
  /** The text below each pair of bars (or next to it, if `horizontal`). */
  labels: string[];
  /** The numbers of dataset A and dataset B for each label: counts, or percents of the rows of the dataset. */
  a: number[];
  b: number[];
  /** The text of the tooltip of each label. One tooltip tells the numbers of A and of B. */
  tips: string[];
  /** The name of dataset A in the legend. The compare cards pass 'A'. */
  nameA: string;
  /** The name of dataset B in the legend. The compare cards pass 'B'. */
  nameB: string;
  /** true: the value axis has a logarithmic scale. A bar with the number 0 does not show. */
  logScale?: boolean;
  /** true: the bars go from left to right, with the first label at the top. */
  horizontal?: boolean;
  /** Writes a number of the value axis. Example: (v) => v + '%'. */
  axisFormat?: (value: number) => string;
  /**
   * The titles of the axes in the detailed view of a column. The function
   * ignores `barLabels` and `numeric`. Use `labelsA` and `labelsB` for the
   * text on the bars.
   */
  detail?: ChartDetail;
  /** In the detailed view: the text on each bar of A and of B. Not set: the bars have no text. */
  labelsA?: string[];
  labelsB?: string[];
}

/**
 * Make the settings of a bar chart that shows dataset A and dataset B next to each other for each label.
 *
 * A has one color and B has another, on each chart. ECharts also draws a
 * different pattern on the bars of each dataset. A person who cannot tell
 * the two colors apart can then tell the datasets apart.
 *
 * @example
 * // The percent of the rows of each dataset that have the value 'web' and 'store'.
 * const option = compareBarsOption(theme, {
 *   labels: ['web', 'store'], a: [66.7, 33.3], b: [50, 50], tips: ['', ''],
 *   nameA: 'A', nameB: 'B', axisFormat: (v) => v + '%',
 * });
 * option.series[0]   // { id: 'a', name: 'A', data: [66.7, 33.3], ... } in the color `theme.a`
 * option.series[1]   // { id: 'b', name: 'B', data: [50, 50], ... } in the color `theme.b`
 */
export function compareBarsOption(theme: Theme, input: CompareBarsInput): ChartOption {
  const detail = input.detail ? { ...input.detail, barLabels: undefined, numeric: undefined } : undefined;
  const base = barsOption(theme, { labels: input.labels, counts: input.a, tips: input.tips, logScale: input.logScale, horizontal: input.horizontal, axisFormat: input.axisFormat, gap: 20, detail }) as Record<string, unknown>;
  const values = (list: number[]) => (input.logScale ? list.map((v) => (v > 0 ? v : null)) : list);
  const label = (texts: string[] | undefined) =>
    texts
      ? {
          label: { show: true, position: input.horizontal ? ('right' as const) : ('top' as const), color: theme.foreground, fontSize: 10, formatter: (item: { dataIndex: number }) => texts[item.dataIndex] ?? '' },
          labelLayout: { hideOverlap: true },
        }
      : {};
  return {
    ...base,
    grid: detail ? { left: input.horizontal ? 8 : 22, right: 36, top: 34, bottom: 26, containLabel: true } : { left: 4, right: 16, top: 32, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, textStyle: { color: theme.foreground, fontFamily: theme.font }, itemWidth: 14, itemHeight: 10 },
    // ECharts draws a pattern on each series. The legend shows the same pattern.
    aria: { enabled: true, label: { enabled: false }, decal: { show: true } },
    series: [
      { id: 'a', type: 'bar', name: input.nameA, data: values(input.a), itemStyle: { color: theme.a }, barGap: '0%', barCategoryGap: '25%', ...label(input.labelsA) },
      { id: 'b', type: 'bar', name: input.nameB, data: values(input.b), itemStyle: { color: theme.b }, barGap: '0%', barCategoryGap: '25%', ...label(input.labelsB) },
    ],
  };
}
