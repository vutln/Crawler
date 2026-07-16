import { Card, SiteBadge } from '@/components/ui';
import { formatNumber } from '@/lib/utils';
import type { MarketplaceStat } from '@/types/api';

/** Renders whatever the API reports — the backend enumerates its own enum. */
export function MarketplacePanel({ stats }: { stats: MarketplaceStat[] }) {
  return (
    <Card className="p-3">
      <h2 className="mb-2 text-sm font-semibold text-slate-800">Marketplaces</h2>
      <p className="mb-2 text-[11px] text-slate-500">
        Which adapter is serving each site. API adapters outrank Selenium automatically when
        credentials are present in the backend's .env.
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        {stats.map((m) => (
          <div
            key={m.marketplace}
            className="flex items-center justify-between rounded border border-slate-200 px-2.5 py-2"
          >
            <div className="flex flex-col gap-1">
              <SiteBadge marketplace={m.marketplace} />
              <span className="font-mono text-[10px] text-slate-500">
                {m.activeAdapter ?? 'no adapter'}
              </span>
            </div>
            <span className="tnum text-lg font-semibold text-slate-900">
              {formatNumber(m.productCount)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
