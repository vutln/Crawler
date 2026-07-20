import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency, formatDateTime } from '@/lib';
import type { PricePoint } from '@/types';

export interface PriceStats {
  min: number;
  max: number;
  avg: number;
}

export function usePriceSeries(points: PricePoint[] | undefined) {
  return useMemo(() => {
    const series = (points ?? [])
      .filter((p) => p.price !== null)
      .map((p) => ({ ts: new Date(p.capturedAt).getTime(), price: p.price as number }));

    if (series.length === 0) return { series, stats: null as PriceStats | null };

    const prices = series.map((p) => p.price);
    return {
      series,
      stats: {
        min: Math.min(...prices),
        max: Math.max(...prices),
        avg: prices.reduce((a, b) => a + b, 0) / prices.length,
      },
    };
  }, [points]);
}

export function PriceHistoryChart({
  series,
  stats,
  currency,
}: {
  series: Array<{ ts: number; price: number }>;
  stats: PriceStats | null;
  currency: string;
}) {
  return (
    <div className="h-72" data-testid="price-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="ts"
            // Recharts' default category axis spaces an overnight gap and a
            // two-week gap identically, misrepresenting scrape cadence.
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(ts: number) =>
              new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            }
            tick={{ fontSize: 11, fill: '#64748b' }}
            stroke="#cbd5e1"
          />
          <YAxis
            tickFormatter={(v: number) => formatCurrency(v, currency)}
            tick={{ fontSize: 11, fill: '#64748b' }}
            width={72}
            domain={['auto', 'auto']}
            stroke="#cbd5e1"
          />
          <Tooltip
            labelFormatter={(ts) => formatDateTime(new Date(ts as number).toISOString())}
            formatter={(value) => [formatCurrency(value as number, currency), 'Price']}
            contentStyle={{ fontSize: 12, borderRadius: 6 }}
          />
          {stats && (
            <ReferenceLine
              y={stats.avg}
              stroke="#94a3b8"
              strokeDasharray="4 4"
              label={{ value: 'avg', position: 'right', fontSize: 10, fill: '#94a3b8' }}
            />
          )}
          <Line
            // A price holds constant between scrapes, then jumps. A smooth curve
            // would draw prices that never existed.
            type="stepAfter"
            dataKey="price"
            stroke="#0f172a"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
