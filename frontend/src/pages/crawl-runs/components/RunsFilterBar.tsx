import { Button, Card, Select } from '@/components/ui';
import { MARKETPLACE_OPTIONS } from '@/domain/marketplace';
import { RUN_STATUS_OPTIONS } from '@/domain/run-status';
import { useCrawlJobs } from '@/hooks/useCrawls';
import { useKeywords } from '@/hooks/useKeywords';
import type { Marketplace, RunStatus } from '@/types/api';

/**
 * Filters the backend has always supported. status/marketplace/jobId existed on
 * ListCrawlRunsDto from the start and nothing exposed them; keywordId and batchId
 * came with the sweep.
 *
 * Options are built from the domain registries (compile-time exhaustive) for the
 * enums, and from live queries for the ids — the distinction src/domain draws.
 */
export function RunsFilterBar({
  filters,
  onChange,
  onReset,
  hasActiveFilters,
  isRefreshing,
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
}) {
  const jobs = useCrawlJobs();
  const keywords = useKeywords();

  return (
    <Card className="flex flex-wrap items-center gap-2 p-2">
      <Select<RunStatus>
        value={filters.status ?? ''}
        onChange={(v) => onChange({ status: v })}
        placeholder="All statuses"
        options={RUN_STATUS_OPTIONS}
        testId="filter-status"
      />

      <Select<Marketplace>
        value={filters.marketplace ?? ''}
        onChange={(v) => onChange({ marketplace: v })}
        placeholder="All sites"
        options={MARKETPLACE_OPTIONS}
        testId="filter-marketplace"
      />

      <Select<string>
        value={filters.keywordId ?? ''}
        onChange={(v) => onChange({ keywordId: v })}
        placeholder="All keywords"
        options={(keywords.data ?? []).map((k) => ({ value: k.id, label: k.text }))}
        testId="filter-keyword"
      />

      <Select<string>
        value={filters.jobId ?? ''}
        onChange={(v) => onChange({ jobId: v })}
        placeholder="All jobs"
        options={(jobs.data ?? []).map((j) => ({ value: j.id, label: j.name }))}
        testId="filter-job"
      />

      {/*
        batchId has no picker — it's a uuid nobody types. It arrives via the "Sweep"
        button on a row or a shared link, so it only needs a way OUT.
      */}
      {filters.batchId && (
        <span className="inline-flex items-center gap-1 rounded bg-slate-900 px-1.5 py-0.5 text-[11px] text-white">
          one sweep
          <button
            onClick={() => onChange({ batchId: undefined })}
            className="text-slate-300 hover:text-white"
            aria-label="Clear sweep filter"
            data-testid="clear-batch"
          >
            ×
          </button>
        </span>
      )}

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={onReset} testId="clear-filters">
          Clear
        </Button>
      )}

      {isRefreshing && <span className="ml-auto text-[11px] text-slate-400">live</span>}
    </Card>
  );
}
