import { Button, Card, Select } from '@/components/ui';
import {
  MARKETPLACE_OPTIONS,
  RUN_STATUS_OPTIONS,
} from '@/domain';
import {
  useCrawlJobs,
  useKeywords,
} from '@/hooks';
import type {
  Marketplace,
  RunStatus,
} from '@/types';

export function RunsFilterBar({
  filters,
  onChange,
  onReset,
  hasActiveFilters,
  isRefreshing,
  hasJobId,
  keywordOptions,
  hideKeyword,
}: {
  filters: {
    status?: RunStatus;
    marketplace?: Marketplace;
    jobId?: string;
    keywordId?: string;
    batchId?: string;
  };
  onChange: (patch: {
    status?: RunStatus;
    marketplace?: Marketplace;
    jobId?: string;
    keywordId?: string;
    batchId?: string;
  }) => void;
  onReset: () => void;
  hasActiveFilters: boolean;
  isRefreshing: boolean;
  hasJobId?: boolean;
  keywordOptions?: ReadonlyArray<{
    value: string;
    label: string;
  }>;
  hideKeyword?: boolean;
}) {
  // The job picker is hidden on job-detail pages, so avoid fetching every job.
  const jobs = useCrawlJobs(!hasJobId);
  const keywords = useKeywords();

  const resolvedKeywordOptions =
    keywordOptions ??
    (keywords.data ?? []).map((keyword) => ({
      value: keyword.id,
      label: keyword.text,
    }));

  return (
    <Card className="flex flex-wrap items-center gap-2 p-2">
      <Select<RunStatus>
        value={filters.status ?? ''}
        onChange={(value) =>
          onChange({ status: value })
        }
        placeholder="All statuses"
        options={RUN_STATUS_OPTIONS}
        testId="filter-status"
      />

      {!hasJobId && (
        <Select<Marketplace>
          value={filters.marketplace ?? ''}
          onChange={(value) =>
            onChange({ marketplace: value })
          }
          placeholder="All sites"
          options={MARKETPLACE_OPTIONS}
          testId="filter-marketplace"
        />
      )}

      {!hideKeyword && (
        <Select<string>
          value={filters.keywordId ?? ''}
          onChange={(value) =>
            onChange({ keywordId: value })
          }
          placeholder="All keywords"
          options={resolvedKeywordOptions}
          testId="filter-keyword"
        />
      )}

      {!hasJobId && (
        <Select<string>
          value={filters.jobId ?? ''}
          onChange={(value) =>
            onChange({ jobId: value })
          }
          placeholder="All jobs"
          options={(jobs.data ?? []).map((job) => ({
            value: job.id,
            label: job.name,
          }))}
          testId="filter-job"
        />
      )}

      {filters.batchId && (
        <span className="inline-flex items-center gap-1 rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-white">
          one sweep
          <button
            onClick={() =>
              onChange({ batchId: undefined })
            }
            className="text-slate-300 hover:text-white"
            aria-label="Clear sweep filter"
            data-testid="clear-batch"
          >
            ×
          </button>
        </span>
      )}

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          testId="clear-filters"
        >
          Clear
        </Button>
      )}

      {isRefreshing && (
        <span className="ml-auto text-[11px] text-slate-400">
          live
        </span>
      )}
    </Card>
  );
}