import { Link } from 'react-router-dom';
import { PriceDelta, SiteBadge, SkeletonRows, Thumbnail } from '@/components/ui';
import { cn, formatCurrency, formatNumber, formatRelative } from '@/lib';
import type { Product, ProductSortBy, SortOrder } from '@/types';

const COLUMNS: Array<{ key: ProductSortBy | null; label: string; className?: string }> = [
  { key: 'title', label: 'Product' },
  { key: null, label: 'Brand' },
  { key: null, label: 'Site' },
  { key: 'price', label: 'Price', className: 'text-right' },
  { key: null, label: '7d', className: 'text-right' },
  { key: 'rating', label: 'Rating', className: 'text-right' },
  { key: null, label: 'Stock' },
  { key: null, label: 'Points', className: 'text-right' },
  { key: 'lastScrapedAt', label: 'Last seen', className: 'text-right' },
];

export const PRODUCT_COLUMN_COUNT = COLUMNS.length;

export function ProductsTable({
  items,
  isPending,
  isFetching,
  sortBy,
  sortOrder,
  onSortChange,
}: {
  items: Product[];
  isPending: boolean;
  isFetching: boolean;
  sortBy: ProductSortBy;
  sortOrder: SortOrder;
  onSortChange: (key: ProductSortBy) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="products-table">
        <thead>
          <tr className="text-left text-[11px] text-slate-500">
            {COLUMNS.map((col) => (
              <th key={col.label} className={cn('px-3 py-2 font-medium', col.className)}>
                {col.key ? (
                  <button onClick={() => onSortChange(col.key!)} className="hover:text-slate-900">
                    {col.label}
                    {sortBy === col.key && (
                      <span className="ml-1">{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>

        {/* Dim on refetch rather than unmount — the table must not reflow on paging. */}
        <tbody className={cn(isFetching && !isPending && 'opacity-60 transition-opacity')}>
          {isPending && <SkeletonRows rows={8} cols={COLUMNS.length} />}

          {!isPending &&
            items.map((p) => (
              <tr
                key={p.id}
                className="border-t border-slate-100 hover:bg-slate-50"
                data-testid="product-row"
              >
                <td className="max-w-md px-3 py-1.5 align-top">
                  {/*
                    imageUrl has been collected since the first crawl and rendered
                    nowhere — it is one of the four required fields. Thumbnail is
                    fixed-size so adding it cannot reflow the table.
                  */}
                  <div className="flex items-start gap-2 pt-1">
                    <Thumbnail src={p.imageUrl} alt="" />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/products/${p.id}`}
                        className="block font-medium text-slate-800 hover:text-blue-600"
                        title={p.title}
                      >
                        {p.title}
                      </Link>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-1.5 align-top pt-2.5">
                  {p.brand ? (
                    <span className="text-[11px] text-slate-600 font-medium bg-slate-100 px-1.5 py-0.5 rounded inline-block whitespace-nowrap overflow-hidden text-ellipsis max-w-xs">{p.brand}</span>
                  ) : (
                    <span className="text-[11px] text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 align-top pt-2.5">
                  <SiteBadge marketplace={p.marketplace} />
                </td>
                <td className="tnum px-3 py-1.5 text-right font-medium align-top pt-2.5">
                  {formatCurrency(p.currentPrice ?? null, p.currency)}
                </td>
                <td className="px-3 py-1.5 text-right align-top pt-2.5">
                  <PriceDelta value={p.priceChange7d} />
                </td>
                <td className="tnum px-3 py-1.5 text-right text-slate-600 align-top pt-2.5">
                  {p.rating != null ? `${p.rating.toFixed(1)}★` : '—'}
                  {p.reviewCount != null && (
                    <span className="ml-1 text-slate-400">({formatNumber(p.reviewCount)})</span>
                  )}
                </td>
                <td className="px-3 py-1.5 align-top pt-2.5">
                  <span className={p.inStock ? 'text-green-700' : 'text-slate-400'}>
                    {p.inStock ? 'In stock' : 'Out'}
                  </span>
                </td>
                <td className="tnum px-3 py-1.5 text-right text-slate-500 align-top pt-2.5">{p.snapshotCount}</td>
                <td
                  className="px-3 py-1.5 text-right text-slate-500 align-top pt-2.5"
                  title={new Date(p.lastScrapedAt).toLocaleString()}
                >
                  {formatRelative(p.lastScrapedAt)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
