import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  cancelCrawlRun,
  createCrawlJob,
  deleteCrawlJob,
  listCrawlJobs,
  listCrawlRuns,
  triggerCrawl,
  updateCrawlJob,
} from '@/api/endpoints';
import { ApiError } from '@/api/http';
import { queryKeys } from '@/api/queryKeys';
import { isActiveStatus } from '@/domain/run-status';
import type {
  CrawlJob,
  CrawlRun,
  CrawlRunListQuery,
  CreateCrawlJobInput,
  UpdateCrawlJobInput,
  PaginatedCrawlRuns,
} from '@/types/api';

export function useCrawlJobs() {
  return useQuery({
    queryKey: queryKeys.crawlJobs.list(),
    queryFn: ({ signal }) => listCrawlJobs(signal),

    // Each job embeds its latest run, so this list goes stale exactly like the
    // runs list. Mutation invalidation alone isn't enough: it fires while the
    // run is still QUEUED, freezing the row there.
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      const anyActive = jobs.some((job) => job.lastRun && isActiveStatus(job.lastRun.status));
      return anyActive ? 2000 : 15_000;
    },
  });
}

export function useCrawlRuns(query: CrawlRunListQuery) {
  return useQuery({
    queryKey: queryKeys.crawlRuns.list(query),
    queryFn: ({ signal }) => listCrawlRuns(query, signal),
    placeholderData: keepPreviousData,
    // Fast only while work is in flight; 15s idle still surfaces cron-triggered
    // runs. refetchIntervalInBackground stays off so hidden tabs go quiet.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((run) => isActiveStatus(run.status)) ? 2000 : 15_000;
    },
  });
}

/** The optimistic row appears instantly and is replaced by the next poll. */
export function useTriggerCrawl() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => triggerCrawl(jobId),

    onMutate: async (jobId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.crawlRuns.all });
      const snapshot = queryClient.getQueriesData<PaginatedCrawlRuns>({
        queryKey: queryKeys.crawlRuns.all,
      });

      // Real values from cache, never invented — a confidently wrong badge is
      // worse than no row for the ~2s this exists.
      const jobs = queryClient.getQueryData<CrawlJob[]>(queryKeys.crawlJobs.list());
      const job = jobs?.find((j) => j.id === jobId);

      queryClient.setQueriesData<PaginatedCrawlRuns>(
        { queryKey: queryKeys.crawlRuns.all },
        (old) => {
          if (!old) return old;
          // Only inject where the run would genuinely appear, or a QUEUED row
          // materializes inside a status=FAILED filter.
          if (old.page !== 1 || !job) return old;

          const optimistic: CrawlRun = {
            id: `optimistic-${jobId}`,
            jobId,
            jobName: job.name,
            marketplace: job.marketplace,
            // Both genuinely unknown here, and null says so.
            //
            // A manual trigger of a KEYWORD_SWEEP fans out server-side into one run
            // PER KEYWORD, so there is no single keyword to name and no batch id
            // until the server has made them. Guessing either would be exactly the
            // "confidently wrong badge" the comment above rejects; the real rows
            // arrive on the next poll ~2s later.
            keyword: null,
            batchId: null,
            status: 'QUEUED',
            trigger: 'MANUAL',
            startedAt: null,
            finishedAt: null,
            itemsFound: 0,
            itemsNew: 0,
            itemsUpdated: 0,
            error: null,
            createdAt: new Date().toISOString(),
            durationMs: null,
          };

          return {
            ...old,
            total: old.total + 1,
            items: [optimistic, ...old.items].slice(0, old.pageSize),
          };
        },
      );

      return { snapshot };
    },

    onError: (error, _jobId, context) => {
      context?.snapshot.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error(error instanceof ApiError ? error.message : 'Failed to start crawl');
    },

    // Say how many, because a sweep queues one run per keyword and "Crawl queued"
    // would understate a 20-run fan-out.
    onSuccess: (runs) => {
      const first = runs[0];
      toast.success(
        runs.length === 1
          ? `Crawl queued for ${first.jobName}`
          : `${runs.length} crawls queued for ${first.jobName} — one per keyword`,
      );
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlRuns.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlJobs.all });
    },
  });
}

export function useCancelRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => cancelCrawlRun(runId),
    onSuccess: () => toast.success('Run cancelled'),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Failed to cancel'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.crawlRuns.all }),
  });
}

export function useCreateCrawlJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCrawlJobInput) => createCrawlJob(input),
    onSuccess: (job) => toast.success(`Created "${job.name}"`),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Failed to create job'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.crawlJobs.all }),
  });
}

export function useUpdateCrawlJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateCrawlJobInput & { id: string }) =>
      updateCrawlJob(id, body),
    onSuccess: (job) => toast.success(`Saved "${job.name}"`),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Failed to save job'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.crawlJobs.all }),
  });
}

export function useDeleteCrawlJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCrawlJob(id),
    onSuccess: () => toast.success('Job deleted'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlJobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlRuns.all });
    },
  });
}
