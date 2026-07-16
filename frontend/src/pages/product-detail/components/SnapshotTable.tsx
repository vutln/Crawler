import { Card } from '@/components/ui';
import { cn, formatCurrency, formatDateTime, formatRelative } from '@/lib/utils';
import type { PricePoint, Product } from '@/types/api';

export function SnapshotTable({
  points,
  product,
}: {
  points: PricePoint[];
  product: Product;
}) {
  return (
    <Card className="p-3">
      <h2 className="mb-2 text-sm font-semibold text-slate-800">Recent observations</h2>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] text-slate-500">
            <th className="py-1 font-medium">Captured</th>
            <th className="py-1 text-right font-medium">Price</th>
            <th className="py-1 text-right font-medium">Stock</th>
          </tr>
        </thead>
        <tbody>
          {points
            .slice(-10)
            .reverse()
            .map((point, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1 text-slate-600">{formatDateTime(point.capturedAt)}</td>
                <td className="tnum py-1 text-right font-medium">
                  {formatCurrency(point.price ?? null, point.currency)}
                </td>
                <td
                  className={cn(
                    'py-1 text-right',
                    point.inStock ? 'text-green-700' : 'text-slate-400',
                  )}
                >
                  {point.inStock ? 'In stock' : 'Out'}
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      <p className="mt-2 text-[11px] text-slate-400">
        First seen {formatRelative(product.firstSeenAt)} · Last scraped{' '}
        {formatRelative(product.lastScrapedAt)}
      </p>
    </Card>
  );
}
