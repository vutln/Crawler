import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, SkeletonRows } from '@/components/ui';
import { useDeleteKeyword } from '@/hooks';
import { formatNumber } from '@/lib';
import type { Keyword } from '@/types';

/**
 * The keyword list.
 *
 * Deliberately only two actions: see what a keyword collected, or remove it.
 *
 * There is no per-keyword "Run now" — it queued an unknown number of runs across an
 * unknown set of sites, which is not something a button should do silently. Crawl
 * Jobs has a "Run now" that says exactly what it will do: this job, this site.
 *
 * There is no enable/disable either. To stop collecting a term you deselect it on
 * the job, or delete it here — a third mechanism meaning almost-but-not-quite the
 * same thing is how a model gets confusing.
 */
export function KeywordsTable({ keywords, isPending }: { keywords: Keyword[]; isPending: boolean }) {
  const remove = useDeleteKeyword();

  if (!isPending && keywords.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No keywords yet"
          description="Add search terms above. The daily sweep collects each one on every site."
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="keywords-table">
          <thead>
            <tr className="text-left text-[11px] text-slate-500">
              <th className="px-3 py-2 font-medium">Keyword</th>
              <th className="px-3 py-2 font-medium">Niche</th>
              <th className="px-3 py-2 text-right font-medium">Products</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isPending && <SkeletonRows rows={4} cols={4} />}

            {keywords.map((k) => (
              <tr key={k.id} className="border-t border-slate-100" data-testid="keyword-row">
                <td className="px-3 py-1.5 font-medium text-slate-800">{k.text}</td>
                <td className="px-3 py-1.5 text-slate-600">{k.niche || '—'}</td>

                <td className="px-3 py-1.5 text-right">
                  {k.productCount > 0 ? (
                    // Deep-links into the Products screen already filtered — the
                    // count is only useful if you can act on it.
                    <Link
                      to={`/products?keywordId=${k.id}`}
                      className="tnum text-slate-700 underline"
                      data-testid={`products-${k.id}`}
                    >
                      {formatNumber(k.productCount)}
                    </Link>
                  ) : (
                    <span className="tnum text-slate-400">0</span>
                  )}
                </td>

                <td className="px-3 py-1.5 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      // Deliberately spells out what survives: deleting a keyword
                      // drops its links, never the price history it collected.
                      if (
                        confirm(
                          `Remove "${k.text}"?\n\nProducts and their price history are kept — ` +
                            `only the link to this keyword goes.`,
                        )
                      ) {
                        remove.mutate(k.id);
                      }
                    }}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
