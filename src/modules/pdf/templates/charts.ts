import * as echarts from 'echarts';

export function chartSvg(c: { type: string; title: string; months: string[]; values: Array<number | null> }, w = 360, h = 170): string {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: w, height: h });
  chart.setOption({
    animation: false,
    title: { text: c.title, left: 'center', textStyle: { fontSize: 10 } },
    grid: { left: 40, right: 10, top: 28, bottom: 22 },
    xAxis: { type: 'category', data: c.months, axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 9 } },
    series: [{
      type: c.type === 'line' ? 'line' : 'bar', data: c.values.map((v) => (v === null ? '-' : Number(v.toFixed(2)))),
      label: { show: true, position: 'top', fontSize: 8 }, itemStyle: { color: '#1f4e9a' },
      ...(c.type === 'cone' ? { barWidth: '40%', itemStyle: { color: '#2e75b6', borderRadius: [20, 20, 0, 0] } } : {}),
    }],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}
