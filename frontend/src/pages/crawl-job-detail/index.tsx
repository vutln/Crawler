import { useParams } from 'react-router';
import { useCrawlJob, useCrawlRuns, useCrawlRunsQueryParams } from '@/hooks';
import { RunsTable, RunsFilterBar } from '../crawl-runs/components';
import { CrawlJobHeader } from './components';

export default function CrawlJobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: crawlJob } = useCrawlJob(id || '');
  const { filters, setFilters, reset, query, hasActiveFilters } = useCrawlRunsQueryParams({jobId: id});
  const runs = useCrawlRuns(query); 

  return (
    <div className="flex flex-col gap-3">
      {crawlJob && <CrawlJobHeader job={crawlJob} runs={runs.data?.items || []} />}
      <RunsFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={reset}
        hasActiveFilters={hasActiveFilters}
        isRefreshing={runs.isFetching && !runs.isPending}
        hasJobId={true}
      />    
      <RunsTable jobId={id} />
    </div>  
  );
}