import { Link } from 'react-router-dom';
import { Button, Card, JobStatusBadge, SiteBadge } from '@/components/ui';
import { isActiveStatus } from '@/domain';
import { formatDateTime, formatNumber, formatRelative } from '@/lib';
import type { CrawlJob, CrawlRun } from '@/types';

export function CrawlJobHeader({
  job,
  latestRun,
  totalRuns,
  onRun,
  onEdit,
  onToggleSchedule,
  onDelete,
  runPending,
  updatePending,
  deletePending,
}: {
  job: CrawlJob;
  latestRun: CrawlRun | null;
  totalRuns?: number;
  onRun: () => void;
  onEdit: () => void;
  onToggleSchedule: () => void;
  onDelete: () => void;
  runPending: boolean;
  updatePending: boolean;
  deletePending: boolean;
}) {
  const runActive = latestRun ? isActiveStatus(latestRun.status) : false;

  const scheduleLabel = !job.cronExpression
    ? 'Manual only'
    : job.enabled
      ? 'Schedule active'
      : 'Schedule paused';

  const scheduleClass = !job.cronExpression
    ? 'bg-slate-100 text-slate-600'
    : job.enabled
      ? 'bg-green-100 text-green-800'
      : 'bg-amber-100 text-amber-800';

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3">
        <Link
          to="/crawl-jobs"
          className="text-[11px] text-slate-500 hover:text-slate-800"
        >
          ← Crawl jobs
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">
                {job.name}
              </h1>

              <SiteBadge marketplace={job.marketplace} />

              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scheduleClass}`}
              >
                {scheduleLabel}
              </span>
            </div>

            <p className="mt-1 text-xs text-slate-500">
              {job.type === 'KEYWORD_SWEEP'
                ? 'Searches this marketplace once for every keyword the job tracks.'
                : 'Re-checks a fixed list of product URLs on this marketplace.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              onClick={onRun}
              disabled={runPending || runActive}
              testId="run-job"
            >
              {runActive
                ? 'Run in progress'
                : runPending
                  ? 'Queueing…'
                  : 'Run now'}
            </Button>

            <Button
              variant="secondary"
              onClick={onEdit}
              disabled={updatePending || deletePending}
            >
              Edit
            </Button>

            {job.cronExpression && (
              <Button
                variant="secondary"
                onClick={onToggleSchedule}
                disabled={updatePending || deletePending}
              >
                {updatePending
                  ? 'Saving…'
                  : job.enabled
                    ? 'Pause schedule'
                    : 'Resume schedule'}
              </Button>
            )}

            <Button
              variant="danger"
              onClick={onDelete}
              disabled={deletePending || runActive}
            >
              {deletePending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      </div>

      <dl className="grid divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3">
          <dt className="text-[11px] font-medium text-slate-500">
            Total runs
          </dt>
          <dd className="tnum mt-1 text-lg font-semibold text-slate-900">
            {formatNumber(totalRuns)}
          </dd>
        </div>

        <div className="px-4 py-3">
          <dt className="text-[11px] font-medium text-slate-500">
            Latest run
          </dt>
          <dd className="mt-1 flex min-h-7 items-center gap-2">
            {latestRun ? (
              <>
                <JobStatusBadge status={latestRun.status} />
                <span
                  className="text-xs text-slate-500"
                  title={formatDateTime(latestRun.createdAt)}
                >
                  {formatRelative(latestRun.createdAt)}
                </span>
              </>
            ) : (
              <span className="text-xs text-slate-400">Never run</span>
            )}
          </dd>
        </div>

        <div className="px-4 py-3">
          <dt className="text-[11px] font-medium text-slate-500">
            Created
          </dt>
          <dd className="mt-1 text-xs text-slate-700">
            {formatDateTime(job.createdAt)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}