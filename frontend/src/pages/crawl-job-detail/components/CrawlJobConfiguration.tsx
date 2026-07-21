import type { ReactNode } from 'react';
import { Card } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib';
import type { CrawlJob } from '@/types';

function Detail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-xs text-slate-800">
        {children}
      </dd>
    </div>
  );
}

export function CrawlJobConfiguration({
  job,
}: {
  job: CrawlJob;
}) {
  return (
    <Card>
      <div className="border-b border-slate-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-800">
          Configuration
        </h2>
        <p className="text-[11px] text-slate-500">
          The definition used when the next run starts.
        </p>
      </div>

      <dl className="grid gap-x-6 gap-y-4 px-4 py-3 sm:grid-cols-2">
        <Detail label="Type">
          {job.type === 'KEYWORD_SWEEP'
            ? 'Keyword sweep'
            : 'Product URL refresh'}
        </Detail>

        <Detail label="Collection depth">
          {job.type === 'KEYWORD_SWEEP'
            ? `${job.maxPages} ${job.maxPages === 1 ? 'page' : 'pages'} per keyword`
            : `${formatNumber(job.urls?.length ?? 0)} product URLs`}
        </Detail>

        <Detail label="Item limit">
          {job.maxItems === null
            ? 'No item cap; page limit only'
            : formatNumber(job.maxItems)}
        </Detail>

        <Detail label="Schedule">
          {job.cronExpression ? (
            <span>
              <code className="rounded bg-slate-100 px-1 py-0.5">
                {job.cronExpression}
              </code>
              <span
                className={
                  job.enabled
                    ? 'ml-1.5 text-green-700'
                    : 'ml-1.5 text-amber-700'
                }
              >
                {job.enabled ? 'active' : 'paused'}
              </span>
            </span>
          ) : (
            'Manual only'
          )}
        </Detail>

        <Detail label="Keyword policy">
          {job.type !== 'KEYWORD_SWEEP'
            ? 'Not applicable'
            : job.trackAllKeywords
              ? 'All keywords, including future additions'
              : `${formatNumber(job.keywords.length)} explicitly selected`}
        </Detail>

        <Detail label="Created">
          {formatDateTime(job.createdAt)}
        </Detail>

        <Detail label="Job ID">
          <code className="break-all text-[11px] text-slate-600">
            {job.id}
          </code>
        </Detail>
      </dl>
    </Card>
  );
}