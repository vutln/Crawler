import { useQuery } from '@tanstack/react-query';
import { listDiagnostics } from '@/api';

export function useDiagnostics(prefix?: string) {
  return useQuery({
    queryKey: ['diagnostics', prefix],
    queryFn: ({ signal }) => listDiagnostics(prefix, signal),
    refetchInterval: 30000,
    enabled: prefix !== undefined,
  });
}
