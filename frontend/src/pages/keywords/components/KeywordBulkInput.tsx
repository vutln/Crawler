import { useMemo, useState } from 'react';
import { Button, Card } from '@/components/ui';
import { useBulkCreateKeywords } from '@/hooks/useKeywords';
import { parseKeywordList, submittableKeywords } from '@/lib/keywords';
import { cn } from '@/lib/utils';
import type { Keyword } from '@/types/api';

/**
 * Paste a keyword list.
 *
 * A textarea with a live chip preview, deliberately NOT a chip/tag input: this is a
 * paste-from-a-spreadsheet job, and chip inputs fight paste by demanding Enter per
 * item. A bare textarea gives no feedback, so the preview does that instead —
 * before you submit, you can see what is new, what is a duplicate, and what is
 * already tracked.
 *
 * The preview is advisory only. The server owns the unique constraint and reports
 * what it actually did; this cannot see a concurrent tab.
 */
export function KeywordBulkInput({ existing }: { existing: Keyword[] }) {
  const bulk = useBulkCreateKeywords();
  const [raw, setRaw] = useState('');

  const existingText = useMemo(() => existing.map((k) => k.text), [existing]);
  const parsed = useMemo(() => parseKeywordList(raw, existingText), [raw, existingText]);

  const toAdd = parsed.filter((k) => !k.duplicate && !k.existing).length;
  const dupes = parsed.filter((k) => k.duplicate).length;
  const already = parsed.filter((k) => !k.duplicate && k.existing).length;

  const submit = () => {
    bulk.mutate(submittableKeywords(parsed), { onSuccess: () => setRaw('') });
  };

  return (
    <Card className="p-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-slate-500">Add keywords</span>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={3}
          placeholder={'One per line — paste straight from a spreadsheet\nmechanical keyboard\nharry potter shirt'}
          data-testid="keyword-paste"
          className={cn(
            'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm',
            'placeholder:text-slate-400 focus:border-slate-500 focus:ring-1 focus:ring-slate-500 focus:outline-none',
          )}
        />
      </label>

      {parsed.length > 0 && (
        <>
          <div className="mt-2 flex flex-wrap gap-1" data-testid="keyword-preview">
            {parsed.map((k, i) => (
              <span
                key={`${k.text}-${i}`}
                title={
                  k.duplicate
                    ? 'Repeated in this paste — will be added once'
                    : k.existing
                      ? 'Already in your list — will be skipped'
                      : 'New'
                }
                className={cn(
                  'inline-flex rounded px-1.5 py-0.5 text-[11px]',
                  k.duplicate
                    ? 'bg-slate-100 text-slate-400 line-through'
                    : k.existing
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-slate-900 text-white',
                )}
              >
                {k.text}
              </span>
            ))}
          </div>

          {/* State the outcome before they commit, in the same words the toast will use. */}
          <p className="mt-1.5 text-[11px] text-slate-500" data-testid="keyword-summary">
            {toAdd} to add
            {already > 0 && ` · ${already} already tracked`}
            {dupes > 0 && ` · ${dupes} duplicate${dupes === 1 ? '' : 's'} in this paste`}
          </p>
        </>
      )}

      <div className="mt-2">
        <Button
          onClick={submit}
          disabled={toAdd === 0 || bulk.isPending}
          testId="keyword-submit"
        >
          {bulk.isPending ? 'Adding…' : `Add ${toAdd || ''} keyword${toAdd === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Card>
  );
}
