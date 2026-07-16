import { Link } from 'react-router-dom';
import { Card, JobStatusBadge, SiteBadge } from '@/components/ui';
import { useCrawlRuns } from '@/hooks/useCrawls';
import { formatRelative } from '@/lib/utils';

export function RecentRuns() {
  const runs = useCrawlRuns({ page: 1, pageSize: 5 });

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-800">Recent runs</h2>
        <Link to="/crawl-jobs" className="text-xs text-blue-600 hover:underline">
          View all →
        </Link>
      </div>

      {runs.data?.items.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-500">
          No runs yet.{' '}
          <Link to="/crawl-jobs" className="text-blue-600 hover:underline">
            Trigger a crawl
          </Link>{' '}
          to start collecting.
        </p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {runs.data?.items.map((run) => (
              <tr key={run.id} className="border-t border-slate-100">
                <td className="px-3 py-1.5">
                  <JobStatusBadge status={run.status} />
                </td>
                <td className="px-3 py-1.5 text-slate-800">{run.jobName}</td>
                <td className="px-3 py-1.5">
                  <SiteBadge marketplace={run.marketplace} />
                </td>
                <td className="tnum px-3 py-1.5 text-right text-slate-500">
                  {run.itemsFound} found
                </td>
                <td className="px-3 py-1.5 text-right text-slate-400">
                  {formatRelative(run.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
