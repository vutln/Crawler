import { Link } from 'react-router-dom';
import { Card, Spinner } from '@/components/ui';
import { formatNumber } from '@/lib';
import type { CrawlJob, Keyword } from '@/types';

type KeywordTarget = Pick<Keyword, 'id' | 'text'> & {
  productCount?: number;
};

export function CrawlJobTargets({
  job,
  allKeywords,
  keywordsPending,
  keywordsError,
}: {
  job: CrawlJob;
  allKeywords?: Keyword[];
  keywordsPending: boolean;
  keywordsError: boolean;
}) {
  if (job.type === 'PRODUCT_URLS') {
    return (
      <Card>
        <div className="border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">
            Product URLs
          </h2>
          <p className="text-[11px] text-slate-500">
            Each run fetches these product detail pages directly.
          </p>
        </div>

        <div className="max-h-64 overflow-y-auto px-4 py-3">
          {(job.urls ?? []).map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block break-all border-b border-slate-100 py-1.5 text-xs text-blue-700 last:border-0 hover:underline"
            >
              {url}
            </a>
          ))}
        </div>
      </Card>
    );
  }

  const byId = new Map(
    (allKeywords ?? []).map((keyword) => [keyword.id, keyword]),
  );

  const targets: KeywordTarget[] = (
    job.trackAllKeywords
      ? (allKeywords ?? [])
      : job.keywords.map(
          (keyword) => byId.get(keyword.id) ?? keyword,
        )
  )
    .slice()
    .sort((a, b) => a.text.localeCompare(b.text));

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            Tracked keywords
          </h2>
          <p className="text-[11px] text-slate-500">
            {job.trackAllKeywords
              ? 'Every keyword is included automatically, including ones added later.'
              : 'Only the explicitly selected keywords below are included.'}
          </p>
        </div>

        <Link
          to="/keywords"
          className="shrink-0 text-xs text-blue-700 hover:underline"
        >
          Manage keywords
        </Link>
      </div>

      <div className="px-4 py-3">
        {job.trackAllKeywords && keywordsPending && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Spinner />
            Loading keywords…
          </div>
        )}

        {job.trackAllKeywords && keywordsError && (
          <p className="text-xs text-red-700">
            The keyword list could not be loaded.
          </p>
        )}

        {targets.length === 0 &&
          (!job.trackAllKeywords ||
            (!keywordsPending && !keywordsError)) && (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {job.trackAllKeywords
                ? 'There are no keywords yet, so this sweep currently has nothing to collect.'
                : 'No keywords are selected, so this sweep cannot produce any runs.'}
            </p>
          )}

        {targets.length > 0 && (
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
            {targets.map((keyword) => (
              <Link
                key={keyword.id}
                to={`/products?keywordId=${keyword.id}`}
                title="View products collected for this keyword"
                className="h-8 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 hover:border-slate-300 hover:bg-slate-100"
              >
                <span>{keyword.text}</span>

                {keyword.productCount !== undefined && (
                  <span className="tnum text-[10px] text-slate-400">
                    {formatNumber(keyword.productCount)} products
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}