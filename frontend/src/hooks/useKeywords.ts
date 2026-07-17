import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  bulkCreateKeywords,
  createKeyword,
  deleteKeyword,
  listKeywords,
  updateKeyword,
} from '@/api/endpoints';
import { ApiError } from '@/api/http';
import { queryKeys } from '@/api/queryKeys';
import type { UpdateKeywordInput } from '@/types/api';

/**
 * The keyword list — what the daily sweep collects.
 *
 * Fetched whole rather than paginated: this is a hand-curated list of search terms,
 * not collected data. It is read by the config screen AND by the jobs table (to say
 * what a sweep will collect), so it lives behind one cache entry.
 */
export function useKeywords() {
  return useQuery({
    queryKey: queryKeys.keywords.list(),
    queryFn: ({ signal }) => listKeywords(signal),
  });
}

/** Every mutation below invalidates the whole keyword prefix — the list is small and always refetched cheaply. */
function useInvalidateKeywords() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.keywords.all });
}

export function useCreateKeyword() {
  const invalidate = useInvalidateKeywords();
  return useMutation({



    mutationFn: (text: string) => createKeyword({ text }),
    onSuccess: async (keyword) => {
      toast.success(`Added "${keyword.text}"`);
      await invalidate();
    },
    onError: (error) => {
      // 409 carries the NORMALIZED text, so a user who typed "Mechanical Keyboard"
      // learns it collided with "mechanical keyboard" rather than seeing a bare error.
      toast.error(error instanceof ApiError ? error.message : 'Could not add keyword');
    },
  });
}

export function useBulkCreateKeywords() {
  const invalidate = useInvalidateKeywords();
  return useMutation({
    mutationFn: (keywords: string[]) => bulkCreateKeywords(keywords),
    onSuccess: async (result) => {
      // Report what actually happened. "12 added, 3 already there" is the difference
      // between a trustworthy paste and a silent no-op the user has to go verify.
      const parts = [`${result.created.length} added`];
      if (result.skipped.length) parts.push(`${result.skipped.length} already tracked`);
      if (result.duplicates.length) parts.push(`${result.duplicates.length} duplicate`);
      toast.success(parts.join(' · '));
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not add keywords');
    },
  });
}

export function useUpdateKeyword() {
  const invalidate = useInvalidateKeywords();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateKeywordInput & { id: string }) => updateKeyword(id, body),
    onSuccess: async () => invalidate(),
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not update keyword');
    },
  });
}

export function useDeleteKeyword() {
  const invalidate = useInvalidateKeywords();
  return useMutation({
    mutationFn: (id: string) => deleteKeyword(id),
    onSuccess: async () => {
      toast.success('Keyword removed');
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove keyword');
    },
  });
}

