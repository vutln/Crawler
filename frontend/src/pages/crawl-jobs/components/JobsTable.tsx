import { Button, Card, EmptyState, ErrorState, JobStatusBadge, SiteBadge, Spinner } from '@/components/ui';
import { useCrawlJobs, useDeleteCrawlJob, useTriggerCrawl } from '@/hooks/useCrawls';
import { formatRelative } from '@/lib/utils';

export function JobsTable() {
  const jobs = useCrawlJobs();
  const trigger = useTriggerCrawl();
  const remove = useDeleteCrawlJob();

  return (
    <Card>
      <div className="border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-800">Definitions</h2>
        <p className="text-[11px] text-slate-500">
          A definition is a template. Each time it fires — manually or on its schedule — it produces
          a run.
        </p>
      </div>

      {jobs.isPending && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {jobs.isError && <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />}

      {jobs.data?.length === 0 && (
        <EmptyState title="No crawl jobs yet" description="Create one above to start collecting." />
      )}

      {jobs.data && jobs.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="jobs-table">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Site</th>
                <th className="px-3 py-2 font-medium">Query</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((job) => (
                <tr key={job.id} className="border-t border-slate-100" data-testid="job-row">
                  <td className="px-3 py-1.5 font-medium text-slate-800">{job.name}</td>
                  <td className="px-3 py-1.5">
                    <SiteBadge marketplace={job.marketplace} />
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">
                    {job.query ?? `${job.urls?.length ?? 0} URLs`}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-slate-500">
                    {job.cronExpression ?? 'manual'}
                  </td>
                  <td className="px-3 py-1.5">
                    {job.lastRun ? (
                      <span className="flex items-center gap-1.5">
                        <JobStatusBadge status={job.lastRun.status} />
                        <span className="text-slate-400">
                          {formatRelative(job.lastRun.createdAt)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-slate-400">never</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      size="sm"
                      onClick={() => trigger.mutate(job.id)}
                      disabled={trigger.isPending}
                      testId={`run-${job.id}`}
                    >
                      Run now
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-1"
                      onClick={() => {
                        if (confirm(`Delete "${job.name}" and all its runs?`)) {
                          remove.mutate(job.id);
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
