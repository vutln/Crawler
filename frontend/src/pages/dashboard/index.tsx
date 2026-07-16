import { useQuery } from '@tanstack/react-query';
import { getStatsOverview } from '@/api/endpoints';
import { queryKeys } from '@/api/queryKeys';
import { ErrorState, Spinner, StatTile } from '@/components/ui';
import { formatNumber } from '@/lib/utils';
import { MarketplacePanel } from './components/MarketplacePanel';
import { RecentRuns } from './components/RecentRuns';

export default function DashboardPage() {
  const stats = useQuery({
    queryKey: queryKeys.stats.overview,
    queryFn: ({ signal }) => getStatsOverview(signal),
    refetchInterval: 30_000,
  });

  if (stats.isError) {
    return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>

      {stats.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile
              label="Products tracked"
              value={formatNumber(stats.data.totalProducts)}
              testId="stat-products"
            />
            <StatTile
              label="Price observations"
              value={formatNumber(stats.data.totalSnapshots)}
              hint="the time series"
            />
            <StatTile label="Price moves (24h)" value={formatNumber(stats.data.priceChanges24h)} />
            <StatTile label="Crawl jobs" value={formatNumber(stats.data.totalJobs)} />
            <StatTile
              label="Active runs"
              value={formatNumber(stats.data.activeRuns)}
              hint={stats.data.activeRuns > 0 ? 'collecting now' : 'idle'}
            />
          </div>

          <MarketplacePanel stats={stats.data.byMarketplace} />
        </>
      )}

      <RecentRuns />
    </div>
  );
}
