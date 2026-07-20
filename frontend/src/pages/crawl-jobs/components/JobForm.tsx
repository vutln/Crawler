import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Field, Input, Select, Spinner } from '@/components/ui';
import { DEFAULT_MARKETPLACE, MARKETPLACE, MARKETPLACE_OPTIONS } from '@/domain';
import { useCreateCrawlJob, useKeywords, useUpdateCrawlJob } from '@/hooks';
import type { CrawlJob, Marketplace } from '@/types';

/**
 * Create or edit a SWEEP PLAN for one marketplace.
 *
 * There is deliberately no query field. A job used to hold its own search term,
 * which is the model Keyword replaced: those runs carried no keywordId, so
 * everything they collected was invisible to the Products screen's keyword filter.
 * WHAT to collect lives in the keyword list; a job decides WHICH of those keywords,
 * on WHICH site, HOW DEEP and WHEN.
 *
 * Renders bare — no Card, no heading. The caller owns the chrome, which is what
 * lets create and edit share one form inside one Modal.
 */
export function JobForm({ job, onDone }: { job?: CrawlJob; onDone: () => void }) {
  const create = useCreateCrawlJob();
  const update = useUpdateCrawlJob();
  const keywords = useKeywords();

  const isEdit = Boolean(job);
  const [name, setName] = useState(job?.name ?? '');
  const [marketplace, setMarketplace] = useState<Marketplace>(
    job?.marketplace ?? DEFAULT_MARKETPLACE,
  );
  const [cron, setCron] = useState(job?.cronExpression ?? '');
  const [maxPages, setMaxPages] = useState(String(job?.maxPages ?? 2));
  const [trackAll, setTrackAll] = useState(job?.trackAllKeywords ?? true);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(job?.keywords.map((k) => k.id) ?? []),
  );

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pending = create.isPending || update.isPending;
  // A job that tracks nothing collects nothing. Blocking beats letting someone save
  // a sweep that silently never runs — `enabled` is the way to pause one.
  const nothingSelected = !trackAll && picked.size === 0;

  const submit = () => {
    const common = {
      name: name.trim(),
      maxPages: Number(maxPages) || 2,
      trackAllKeywords: trackAll,
      // Sent even when tracking all: the server keeps the selection so toggling
      // back doesn't lose the picks.
      keywordIds: [...picked],
      // null, NOT a number. An item cap silently truncates the last page — eBay
      // serves 60 per page, so a hardcoded 100 cut page 2 two-thirds through with
      // nothing in the run to say so. maxPages is the bound.
      maxItems: null,
      cronExpression: cron.trim() || undefined,
    };

    if (job) {
      update.mutate({ id: job.id, ...common }, { onSuccess: onDone });
    } else {
      create.mutate(
        { ...common, marketplace, type: 'KEYWORD_SWEEP', enabled: true },
        { onSuccess: onDone },
      );
    }
  };

  const note = MARKETPLACE[marketplace].note;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={setName}
            placeholder="Daily keyword sweep (eBay)"
            className="w-56"
            testId="job-name"
          />
        </Field>

        <Field label="Site">
          {/* A job's marketplace decides its adapter and its outstanding-run guard;
              changing it after the fact would silently reinterpret its whole run
              history, so it is create-only. */}
          <Select<Marketplace>
            value={marketplace}
            onChange={(v) => v && setMarketplace(v)}
            options={MARKETPLACE_OPTIONS}
            disabled={isEdit}
            testId="job-marketplace"
          />
        </Field>

        <Field label="Pages per keyword">
          <Input type="number" value={maxPages} onChange={setMaxPages} className="w-20" />
        </Field>

        <Field label="Cron (optional)">
          <Input value={cron} onChange={setCron} placeholder="0 0 6 * * *" className="w-32" />
        </Field>
      </div>

      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="mb-1.5 text-[11px] font-medium text-slate-600">Collects</p>

        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="radio"
              checked={trackAll}
              onChange={() => setTrackAll(true)}
              data-testid="track-all"
            />
            {/* The point of the flag, stated: new keywords join automatically. */}
            <span>
              All keywords <span className="text-slate-400">— including ones added later</span>
            </span>
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700">
            <input
              type="radio"
              checked={!trackAll}
              onChange={() => setTrackAll(false)}
              data-testid="track-some"
            />
            <span>
              Only these <span className="text-slate-400">— new keywords will NOT be added</span>
            </span>
          </label>
        </div>

        {!trackAll && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded border border-slate-200 p-2">
            {keywords.isPending && <Spinner />}
            {keywords.data?.length === 0 && (
              <p className="text-[11px] text-slate-500">
                No keywords yet —{' '}
                <Link to="/keywords" className="underline">
                  add some
                </Link>
                .
              </p>
            )}
            {keywords.data?.map((k) => (
              <label
                key={k.id}
                className="flex cursor-pointer items-center gap-2 py-0.5 text-xs text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={picked.has(k.id)}
                  onChange={() => toggle(k.id)}
                  data-testid="keyword-option"
                />
                <span>{k.text}</span>
              </label>
            ))}
          </div>
        )}

        {nothingSelected && (
          <p className="mt-1.5 text-[11px] text-amber-700">
            Pick at least one keyword, or this sweep will collect nothing.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          onClick={submit}
          disabled={!name.trim() || nothingSelected || pending}
          testId="job-submit"
        >
          {pending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {note && <p className="mt-2 text-[11px] text-amber-700">{note}</p>}
    </div>
  );
}
