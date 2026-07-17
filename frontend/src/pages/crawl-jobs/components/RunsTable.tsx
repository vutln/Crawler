import { useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  JobStatusBadge,
  Pagination,
  Select,
  SiteBadge,
} from '@/components/ui';
import { isActiveStatus, RUN_STATUS_OPTIONS } from '@/domain/run-status';
import { useCancelRun, useCrawlRuns } from '@/hooks/useCrawls';
import { formatDuration, formatRelative } from '@/lib/utils';
import type { RunStatus } from '@/types/api';

const PAGE_SIZE = 25;

export function RunsTable() {
  const [statusFilter, setStatusFilter] = useState<RunStatus | undefined>();
  const [page, setPage] = useState(1);

  const runs = useCrawlRuns({ page, pageSize: PAGE_SIZE, status: statusFilter });
  const cancel = useCancelRun();

  const blocked = (runs.data?.items ?? []).find((r) => r.status === 'BLOCKED' && r.error);

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-800">Runs</h2>
        <div className="flex items-center gap-2">
          {runs.isFetching && <span className="text-[11px] text-slate-400">live</span>}
          <Select<RunStatus>
            value={statusFilter ?? ''}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            placeholder="All statuses"
            options={RUN_STATUS_OPTIONS}
          />
        </div>
      </div>

      {runs.isError && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />}

      {runs.data?.items.length === 0 && (
        <EmptyState title="No runs yet" description="Trigger a job above to see it here." />
      )}

      {runs.data && runs.data.items.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="runs-table">
              <thead>
                <tr className="text-left text-[11px] text-slate-500">
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">Site</th>
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
                {runs.data.items.map((run) => (
                  <tr key={run.id} className="border-t border-slate-100" data-testid="run-row">
                    <td className="px-3 py-1.5 text-slate-800">{run.jobName}</td>
                    <td className="px-3 py-1.5">
                      <SiteBadge marketplace={run.marketplace} />
                    </td>
                    <td className="px-3 py-1.5">
                      <span title={run.error ?? undefined}>
                        <JobStatusBadge status={run.status} />
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">{run.trigger}</td>
                    <td className="tnum px-3 py-1.5 text-right">{run.itemsFound}</td>
                    <td className="tnum px-3 py-1.5 text-right text-green-700">{run.itemsNew}</td>
                    <td className="tnum px-3 py-1.5 text-right text-slate-500">
                      {run.itemsUpdated}
                    </td>
                    <td className="tnum px-3 py-1.5 text-right text-slate-500">
                      {formatDuration(run.durationMs ?? null)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-500">
                      {formatRelative(run.createdAt)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
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

          {/* BLOCKED is an expected outcome for some sites; surface the evidence. */}
          {blocked && (
            <div className="mx-3 mb-2 rounded border border-purple-200 bg-purple-50 px-2 py-1.5 text-[11px] text-purple-900">
              <strong>Blocked:</strong> {blocked.error}
              <div className="mt-0.5 text-purple-700">
                The site served an anti-bot page.
              </div>
            </div>
          )}

          <div className="border-t border-slate-100">
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={runs.data.total}
              onPageChange={setPage}
            />
          </div>
        </>
      )}
    </Card>
  );
}
