/**
 * Draw one chart with Apache ECharts.
 *
 * The file loads only the parts of ECharts that the feature uses: bar
 * charts, the grid, the tooltip and the description for screen readers.
 * ECharts draws on a canvas, which the Content Security Policy permits.
 */
import { BarChart } from 'echarts/charts';
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

echarts.use([BarChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

/** The settings of a chart, in the format of ECharts. options.ts makes them. */
export type ChartOption = Parameters<echarts.ECharts['setOption']>[0];

/**
 * @param option  What the chart shows.
 * @param label  One sentence that tells a screen reader what the chart shows.
 * @param height  The height in pixels. Default: 220.
 */
export function Chart({ option, label, height }: { option: ChartOption; label: string; height?: number }) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | undefined>(undefined);

  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    // Draw the chart again when the card changes its width.
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = undefined;
    };
  }, []);

  useEffect(() => {
    // `true`: replace the old settings. Do not merge them with the new settings.
    chart.current?.setOption(option, true);
  }, [option]);

  // React sets the height through the style object of the element. The Content Security Policy permits that.
  return <div ref={element} className="chart" role="img" aria-label={label} style={height ? { height } : undefined} />;
}
