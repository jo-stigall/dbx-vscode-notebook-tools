/**
 * Draw one chart with Apache ECharts.
 *
 * The file loads only the parts of ECharts that the feature uses: bar
 * charts, the grid, the tooltip, the legend, the brush and the patterns for
 * series. ECharts draws on a canvas, which the Content Security Policy
 * permits.
 */
import { BarChart } from 'echarts/charts';
import { AriaComponent, BrushComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, BrushComponent, MarkLineComponent, AriaComponent, CanvasRenderer]);

/** The settings of a chart, in the format of ECharts. options.ts makes them. */
export type ChartOption = Parameters<echarts.ECharts['setOption']>[0];

/** The charts on the page, by their element. The export buttons of a card find the chart of a card with it. */
const instances = new WeakMap<Element, echarts.ECharts>();

/**
 * Get the picture of a chart as a PNG image.
 *
 * @param element  The element of the chart: the one with the class "chart".
 * @param background  The color behind the chart. A PNG without it is transparent.
 * @returns A data URL ("data:image/png;base64,..."), or undefined if the element has no chart.
 */
export function chartPng(element: Element, background: string): string | undefined {
  return instances.get(element)?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: background });
}

/**
 * Get the settings and the size of a chart, to draw it again as SVG. See chartSvg() in export.ts.
 */
export function chartState(element: Element): { option: ChartOption; width: number; height: number } | undefined {
  const chart = instances.get(element);
  return chart ? { option: chart.getOption() as ChartOption, width: chart.getWidth(), height: chart.getHeight() } : undefined;
}

/**
 * Describe the parts of a chart as text: the type of each axis, the id of
 * each series, and which of them have a title or labels.
 * Two charts with the same text differ only in their numbers.
 *
 * ECharts keeps a setting of the old chart if the new chart does not set
 * it. Thus a chart that loses a part (for example, the labels on its bars)
 * must have a different text, so that it is drawn new.
 */
function shapeOf(option: object): string {
  type Part = { type?: string; id?: string; name?: string; label?: unknown };
  const list = (value: unknown): Part[] => (Array.isArray(value) ? value : value ? [value] : []) as Part[];
  const o = option as { xAxis?: unknown; yAxis?: unknown; series?: unknown; legend?: unknown; brush?: unknown };
  const part = (items: Part[]) => items.map((item) => `${item.id ?? ''}:${item.type ?? ''}:${item.name ? 'title' : ''}:${item.label ? 'labels' : ''}`).join(',');
  return [part(list(o.xAxis)), part(list(o.yAxis)), part(list(o.series)), o.legend ? 'legend' : '', o.brush ? 'brush' : ''].join('|');
}

export interface ChartProps {
  /** What the chart shows. */
  option: ChartOption;
  /** One sentence that tells a screen reader what the chart shows. */
  label: string;
  /** The height in pixels. Default: 220. */
  height?: number;
  /**
   * The user selected bars: a click on one bar, or a drag across some bars.
   * `first` and `last` are the positions of the bars on the category axis, from 0.
   */
  onSelect?: (first: number, last: number) => void;
  /** true: a drag across the chart selects a range of bars. Use it for a histogram and a date chart. */
  range?: boolean;
  /** true: the category axis is the vertical axis. */
  horizontal?: boolean;
}

export function Chart({ option, label, height, onSelect, range, horizontal }: ChartProps) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | undefined>(undefined);
  // The newest callback. The listeners of the chart are added one time and read it from here.
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    instances.set(element.current, instance);
    // Draw the chart again when the card changes its width.
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element.current);

    // A drag ends with a click. Ignore a click that comes directly after a drag.
    let lastBrush = 0;
    instance.on('brushEnd', (event) => {
      const area = (event as { areas?: { coordRange?: number[] }[] }).areas?.[0];
      const [from, to] = area?.coordRange ?? [];
      if (from === undefined || to === undefined) return;
      lastBrush = Date.now();
      instance.dispatchAction({ type: 'brush', areas: [] }); // remove the selection rectangle
      select.current?.(Math.round(Math.min(from, to)), Math.round(Math.max(from, to)));
    });
    instance.getZr().on('click', (event) => {
      if (!select.current || Date.now() - lastBrush < 300) return;
      const point = [event.offsetX, event.offsetY];
      if (!instance.containPixel('grid', point)) return;
      const position = instance.convertFromPixel({ seriesIndex: 0 }, point) as number[];
      const index = Math.round(position[element.current?.dataset.horizontal === 'true' ? 1 : 0] as number);
      if (Number.isFinite(index) && index >= 0) select.current(index, index);
    });
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = undefined;
    };
  }, []);

  const selectable = onSelect !== undefined;
  // The parts of the last chart: the types of its axes and the names of its series.
  const shape = useRef('');
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const brush = range && selectable ? { brush: { xAxisIndex: 0, brushMode: 'single', transformable: false, throttleType: 'debounce', throttleDelay: 0 } } : {};
    const next = { ...(option as object), ...brush };
    const nextShape = shapeOf(next);
    if (nextShape === shape.current) {
      // The same kind of chart with new numbers: keep the bars and move them to their new heights.
      instance.setOption(next, { replaceMerge: ['xAxis', 'yAxis', 'series'] });
    } else {
      // A different kind of chart, for example from one dataset to two: draw it new.
      instance.setOption(next, true);
    }
    shape.current = nextShape;
    // Make a drag select a range. Without this, the user must first click a brush button, and the chart has none.
    if (range && selectable) instance.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
  }, [option, range, selectable]);

  // React sets the height through the style object of the element. The Content Security Policy permits that.
  return (
    <div
      ref={element}
      className={`chart${selectable ? ' selectable' : ''}`}
      role="img"
      aria-label={label + (selectable ? (range ? ' Click a bar or drag across bars to filter the dataset.' : ' Click a bar to filter the dataset.') : '')}
      data-horizontal={horizontal ? 'true' : 'false'}
      style={height ? { height } : undefined}
    />
  );
}
