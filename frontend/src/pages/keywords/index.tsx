import { Link } from 'react-router-dom';
import { ErrorState } from '@/components/ui';
import { useKeywords } from '@/hooks/useKeywords';
import { KeywordBulkInput } from './components/KeywordBulkInput';
import { KeywordsTable } from './components/KeywordsTable';

/**
 * The keyword-list configuration screen.
 *
 * This IS the feature's input: a sweep collects the keywords it tracks. Adding one
 * here changes what tomorrow collects, with no job or cron edit — the whole reason
 * keywords are data rather than a field on a job.
 */
export default function KeywordsPage() {
  const keywords = useKeywords();

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Keywords</h1>
        <span className="tnum text-xs text-slate-500">
          {keywords.data ? `${keywords.data.length} tracked` : '—'}
        </span>
      </header>

      {/* Say where collection is actually decided, since it isn't here. */}
      <p className="text-xs text-slate-500">
        Each sweep collects the keywords it tracks — set that per site in{' '}
        <Link to="/crawl-jobs" className="text-slate-700 underline">
          Crawl Jobs
        </Link>
        . Removing a keyword here stops it everywhere; products and price history are kept.
      </p>

      <KeywordBulkInput existing={keywords.data ?? []} />

      {keywords.isError && (
        <ErrorState error={keywords.error} onRetry={() => void keywords.refetch()} />
      )}

      {!keywords.isError && (
        <KeywordsTable keywords={keywords.data ?? []} isPending={keywords.isPending} />
      )}
    </div>
  );
}
