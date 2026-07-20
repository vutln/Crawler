import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  JobStatusBadge,
  Pagination,
  SiteBadge,
  SkeletonRows,
} from '@/components/ui';
import { isActiveStatus } from '@/domain';
import { useCancelRun, useCrawlRuns, useCrawlRunsQueryParams } from '@/hooks';
import { formatDuration, formatRelative } from '@/lib';

export function RunsTable() {
  const { filters, setFilters, reset, query, hasActiveFilters } = useCrawlRunsQueryParams();
  const runs = useCrawlRuns(query);
  const cancel = useCancelRun();

  const blocked = (runs.data?.items ?? []).find((r) => r.status === 'BLOCKED' && r.error);

  return (
    <Card>
      {runs.isError && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />}

      {!runs.isError && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="runs-table">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Site</th>
                {/* The column that makes a 20-run sweep readable. */}
                <th className="px-3 py-2 font-medium">Keyword</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 text-right font-medium">Found</th>
                <th className="px-3 py-2 text-right font-medium">New</th>
                <th className="px-3 py-2 text-right font-medium">Updated</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 text-right font-medium">When</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {runs.isPending && <SkeletonRows rows={6} cols={11} />}

              {runs.data?.items.map((run) => (
                <tr key={run.id} className="border-t border-slate-100" data-testid="run-row">
                  <td className="px-3 py-1.5 text-slate-800">{run.jobName}</td>
                  <td className="px-3 py-1.5">
                    <SiteBadge marketplace={run.marketplace} />
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">
                    {run.keyword ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <span title={run.error ?? undefined}>
                      <JobStatusBadge status={run.status} />
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{run.trigger}</td>
                  <td className="tnum px-3 py-1.5 text-right">{run.itemsFound}</td>
                  <td className="tnum px-3 py-1.5 text-right text-green-700">{run.itemsNew}</td>
                  <td className="tnum px-3 py-1.5 text-right text-slate-500">{run.itemsUpdated}</td>
                  <td className="tnum px-3 py-1.5 text-right text-slate-500">
                    {formatDuration(run.durationMs ?? null)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-slate-500">
                    {formatRelative(run.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {/* The optimistic row has no server run to cancel yet. */}
                    {isActiveStatus(run.status) && !run.id.startsWith('optimistic-') && (
                      <Button size="sm" variant="ghost" onClick={() => cancel.mutate(run.id)}>
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!runs.isPending && !runs.isError && runs.data?.items.length === 0 && (
        <EmptyState
          title={hasActiveFilters ? 'No runs match these filters' : 'No runs yet'}
          description={
            hasActiveFilters
              ? undefined
              : 'Runs appear here when a sweep fires, or when you trigger one.'
          }
          action={
            hasActiveFilters
              ? { label: 'Clear filters', onClick: reset }
              : { label: 'Go to Crawl Jobs', to: '/crawl-jobs' }
          }
        />
      )}

      {/* BLOCKED is an expected outcome for some sites; surface the evidence. */}
      {blocked && (
        <div className="mx-3 mb-2 rounded border border-purple-200 bg-purple-50 px-2 py-1.5 text-[11px] text-purple-900">
          <strong>Blocked:</strong> {blocked.error}
          <div className="mt-0.5 text-purple-700">The site served an anti-bot page.</div>
        </div>
      )}

      {!runs.isError && (runs.data?.total ?? 0) > 0 && (
        <div className="border-t border-slate-100">
          <Pagination
            page={filters.page}
            pageSize={filters.pageSize}
            total={runs.data?.total ?? 0}
            onPageChange={(page) => setFilters({ page })}
          />
        </div>
      )}
    </Card>
  );
}
