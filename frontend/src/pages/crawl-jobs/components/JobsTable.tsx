import { useState } from 'react';
import { Button, Card, EmptyState, ErrorState, JobStatusBadge, Modal, SiteBadge, Spinner } from '@/components/ui';
import { useCrawlJobs, useDeleteCrawlJob, useTriggerCrawl } from '@/hooks/useCrawls';
import { useKeywords } from '@/hooks/useKeywords';
import { formatRelative } from '@/lib/utils';
import { JobForm } from './JobForm';

export function JobsTable() {
  const jobs = useCrawlJobs();
  const trigger = useTriggerCrawl();
  const remove = useDeleteCrawlJob();
  // Track the id, not the job object: the list polls every 2–15s, and holding a
  // snapshot would silently edit a stale copy.
  const [editing, setEditing] = useState<string | null>(null);
  const editingJob = jobs.data?.find((j) => j.id === editing) ?? null;

  // What a track-all sweep will collect: every keyword there is. Undefined while
  // loading, so the cell omits the number rather than flashing a wrong one.
  const keywords = useKeywords();
  const keywordCount = keywords.data?.length;

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
                {/* Was "Query" — a sweep has no query; it collects the keyword list. */}
                <th className="px-3 py-2 font-medium">Collects</th>
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
                  {/*
                    Say what the job actually does. This read `job.query ?? \`${urls} URLs\``,
                    so a sweep — which has no query and no urls — rendered the
                    meaningless "0 URLs" and never mentioned keywords at all.

                    Read trackAllKeywords FIRST: a track-all job's `keywords` array is
                    empty by design, so counting it would report "0 keywords" for the
                    job that collects every one of them.
                  */}
                  <td className="px-3 py-1.5 text-slate-600">
                    {job.type !== 'KEYWORD_SWEEP' ? (
                      `${job.urls?.length ?? 0} URLs`
                    ) : job.trackAllKeywords ? (
                      <span title="Keywords added later are collected automatically">
                        All keywords
                        {keywordCount !== undefined && (
                          <span className="text-slate-400"> ({keywordCount})</span>
                        )}
                        <span className="text-slate-400"> · {job.maxPages}p each</span>
                      </span>
                    ) : (
                      <span title={job.keywords.map((k) => k.text).join(', ') || 'nothing selected'}>
                        <span className={job.keywords.length === 0 ? 'text-amber-700' : undefined}>
                          {job.keywords.length} selected
                        </span>
                        <span className="text-slate-400"> · {job.maxPages}p each</span>
                      </span>
                    )}
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
                      onClick={() => setEditing(job.id)}
                      testId={`edit-${job.id}`}
                    >
                      Edit
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

      {/*
        Mounted only while editing, so the form re-seeds from the job each time it
        opens. <dialog> keeps children in the DOM regardless, so a persistently
        mounted form would reopen holding the PREVIOUS job's edits — and JobForm
        reads its props into state on first render only.
      */}
      {editingJob && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={`Edit "${editingJob.name}"`}
          description="Changes apply to the next run. Site can't be changed after creation."
          testId="job-modal"
        >
          <JobForm job={editingJob} onDone={() => setEditing(null)} />
        </Modal>
      )}
    </Card>
  );
}
