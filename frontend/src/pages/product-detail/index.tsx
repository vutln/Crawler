import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorState, Spinner } from '@/components/ui';
import { useProduct, usePriceHistory, type HistoryRange } from '@/hooks/useProducts';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { PriceHistoryChart, usePriceSeries } from './components/PriceHistoryChart';
import { ProductHeader, SnapshotStat } from './components/ProductHeader';
import { SnapshotTable } from './components/SnapshotTable';

const RANGES: HistoryRange[] = ['7d', '30d', '90d', 'all'];

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<HistoryRange>('30d');

  const product = useProduct(id);
  const history = usePriceHistory(id, range);
  const { series, stats } = usePriceSeries(history.data);

  if (product.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (product.isError) {
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;
  }

  const p = product.data!;
  const currency = p.currency;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Link to="/products" className="text-xs text-slate-500 hover:text-slate-900">
          ← Back to products
        </Link>
      </div>

      <ProductHeader product={p} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SnapshotStat label="Low" value={stats ? formatCurrency(stats.min, currency) : '—'} />
        <SnapshotStat label="High" value={stats ? formatCurrency(stats.max, currency) : '—'} />
        <SnapshotStat label="Average" value={stats ? formatCurrency(stats.avg, currency) : '—'} />
        <SnapshotStat label="Observations" value={formatNumber(p.snapshotCount)} />
      </div>

      <Card className="p-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Price history</h2>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? 'primary' : 'ghost'}
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
        </div>

        {history.isPending && (
          <div className="flex h-72 items-center justify-center">
            <Spinner />
          </div>
        )}

        {history.isError && (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        )}

        {!history.isPending && !history.isError && series.length === 0 && (
          <EmptyState
            title="No price history in this range"
            description="Try a wider range, or run the crawl again to add another observation."
          />
        )}

        {series.length > 0 && (
          <PriceHistoryChart series={series} stats={stats} currency={currency} />
        )}
      </Card>

      <SnapshotTable points={history.data ?? []} product={p} />
    </div>
  );
}
