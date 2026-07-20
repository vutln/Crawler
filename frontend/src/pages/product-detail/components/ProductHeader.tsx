import { Card, PriceDelta, SiteBadge, Thumbnail } from '@/components/ui';
import { MARKETPLACE } from '@/domain';
import { formatCurrency, formatNumber } from '@/lib';
import type { Product } from '@/types';

export function ProductHeader({ product }: { product: Product }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          {/*
            Bigger than the table's 32px — there is room here, and it is the one
            place you look at a single product. Same fixed-size, onError-guarded
            primitive: hot-linked marketplace CDN images 403 and expire.
          */}
          <Thumbnail src={product.imageUrl} alt={product.title} size={96} testId="product-image" />

          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <SiteBadge marketplace={product.marketplace} />
              <span className="font-mono text-[11px] text-slate-400">{product.externalId}</span>
            </div>

            <h1 className="text-base font-semibold text-slate-900" data-testid="product-title">
              {product.title}
            </h1>

            {/*
              Rating and review count were on the list but not here — an odd gap,
              since review count is one of the fields this project exists to collect.
            */}
            {(product.rating != null || product.reviewCount != null) && (
              <div className="mt-1 text-xs text-slate-600" data-testid="product-reviews">
                {product.rating != null && <span>{product.rating.toFixed(1)}★</span>}
                {product.reviewCount != null && (
                  <span className="ml-1 text-slate-400">
                    ({formatNumber(product.reviewCount)} reviews)
                  </span>
                )}
              </div>
            )}

            <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-500">
              {product.brand && <span>Brand: {product.brand}</span>}
              {product.seller && <span>Seller: {product.seller}</span>}
              <a
                href={product.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-600 hover:underline"
              >
                View on {MARKETPLACE[product.marketplace].label} ↗
              </a>
            </div>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="tnum text-2xl font-semibold text-slate-900">
            {formatCurrency(product.currentPrice ?? null, product.currency)}
          </div>
          <PriceDelta value={product.priceChange7d} />
          <div className="mt-0.5 text-[11px] text-slate-400">7-day change</div>
        </div>
      </div>
    </Card>
  );
}

export function SnapshotStat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-2.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="tnum mt-0.5 text-sm font-semibold text-slate-900">{value}</div>
    </Card>
  );
}
