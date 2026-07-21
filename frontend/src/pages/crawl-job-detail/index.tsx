import { useMemo, useState } from 'react';
import {
  Link,
  useNavigate,
  useParams,
} from 'react-router-dom';
import {
  Card,
  ErrorState,
  Modal,
  Spinner,
} from '@/components/ui';
import {
  useCrawlJob,
  useCrawlRuns,
  useCrawlRunsQueryParams,
  useDeleteCrawlJob,
  useKeywords,
  useTriggerCrawl,
  useUpdateCrawlJob,
} from '@/hooks';
import type { CrawlRunListQuery } from '@/types';
import { JobForm } from '../crawl-jobs/components';
import {
  RunsFilterBar,
  RunsTable,
} from '../crawl-runs/components';
import {
  CrawlJobConfiguration,
  CrawlJobHeader,
  CrawlJobTargets,
} from './components';

export default function CrawlJobDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const jobQuery = useCrawlJob(id);
  const keywords = useKeywords();
  const trigger = useTriggerCrawl();
  const update = useUpdateCrawlJob();
  const remove = useDeleteCrawlJob();

  // Keep the summary independent of the run-history filters.
  const summaryQuery = useMemo<CrawlRunListQuery>(
    () => ({
      page: 1,
      pageSize: 1,
      jobId: id,
    }),
    [id],
  );

  const runSummary = useCrawlRuns(summaryQuery);

  // jobId is fixed by the current route. Other filters remain in the URL.
  const fixedRunScope = useMemo<CrawlRunListQuery>(
    () => ({ jobId: id }),
    [id],
  );

  const {
    filters,
    setFilters,
    reset,
    query,
  } = useCrawlRunsQueryParams(fixedRunScope);

  const filteredRuns = useCrawlRuns(query);

  if (jobQuery.isPending) {
    return (
      <Card className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </Card>
    );
  }

  if (jobQuery.isError) {
    return (
      <div className="flex flex-col gap-3">
        <Link
          to="/crawl-jobs"
          className="text-xs text-slate-500 hover:text-slate-800"
        >
          ← Crawl jobs
        </Link>

        <Card>
          <ErrorState
            error={jobQuery.error}
            onRetry={() => void jobQuery.refetch()}
          />
        </Card>
      </div>
    );
  }

  const job = jobQuery.data;

  if (!job) {
    return null;
  }

  const latestRun =
    runSummary.data?.items[0] ?? job.lastRun;

  const hasVisibleRunFilters = Boolean(
    filters.status ??
      filters.marketplace ??
      filters.keywordId ??
      filters.batchId,
  );

  // Include all existing keywords because an old run may reference a keyword
  // that is no longer selected by this job.
  const keywordOptions = (keywords.data ?? []).map(
    (keyword) => ({
      value: keyword.id,
      label: keyword.text,
    }),
  );

  const deleteJob = () => {
    const confirmed = confirm(
      `Delete "${job.name}" and its run history?\n\n` +
        'Collected products and price snapshots will be kept.',
    );

    if (!confirmed) {
      return;
    }

    remove.mutate(job.id, {
      onSuccess: () => navigate('/crawl-jobs'),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <CrawlJobHeader
        job={job}
        latestRun={latestRun}
        totalRuns={runSummary.data?.total}
        onRun={() => trigger.mutate(job.id)}
        onEdit={() => setEditing(true)}
        onToggleSchedule={() =>
          update.mutate({
            id: job.id,
            enabled: !job.enabled,
          })
        }
        onDelete={deleteJob}
        runPending={trigger.isPending}
        updatePending={update.isPending}
        deletePending={remove.isPending}
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
        <CrawlJobTargets
          job={job}
          allKeywords={keywords.data}
          keywordsPending={keywords.isPending}
          keywordsError={keywords.isError}
        />

        <CrawlJobConfiguration job={job} />
      </div>

      <section
        className="flex flex-col gap-2"
        aria-labelledby="run-history-title"
      >
        <div className="flex items-baseline justify-between">
          <h2
            id="run-history-title"
            className="text-sm font-semibold text-slate-800"
          >
            Run history
          </h2>

          <span className="tnum text-[11px] text-slate-500">
            {hasVisibleRunFilters &&
            filteredRuns.data &&
            runSummary.data
              ? `${filteredRuns.data.total.toLocaleString()} of ${runSummary.data.total.toLocaleString()} runs`
              : runSummary.data
                ? `${runSummary.data.total.toLocaleString()} total`
                : '—'}
          </span>
        </div>

        <RunsFilterBar
          filters={filters}
          onChange={setFilters}
          onReset={reset}
          hasActiveFilters={hasVisibleRunFilters}
          isRefreshing={
            filteredRuns.isFetching &&
            !filteredRuns.isPending
          }
          hasJobId
          keywordOptions={keywordOptions}
          hideKeyword={job.type === 'PRODUCT_URLS'}
        />

        <RunsTable jobId={id} />
      </section>

      {editing && (
        <Modal
          open
          onClose={() => setEditing(false)}
          title={`Edit "${job.name}"`}
          description="Changes apply to the next run. The marketplace cannot be changed."
          testId="job-modal"
        >
          <JobForm
            job={job}
            onDone={() => setEditing(false)}
          />
        </Modal>
      )}
    </div>
  );
}