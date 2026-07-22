import { useState, useMemo } from 'react';
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
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
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

  const keywordsByNiche = useMemo(() => {
    if (!keywords.data) return {};
    return keywords.data.reduce((acc, k) => {
      const n = k.niche || 'Other';
      if (!acc[n]) acc[n] = [];
      acc[n].push(k);
      return acc;
    }, {} as Record<string, typeof keywords.data>);
  }, [keywords.data]);

  const pending = create.isPending || update.isPending;
  // A job that tracks nothing collects nothing. Blocking beats letting someone save
  // a sweep that silently never runs — `enabled` is the way to pause one.
  const nothingSelected = !trackAll && picked.size === 0;

  const submit = () => {
    const cronExpression = cron.trim();

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
      enabled,
    };

    if (job) {
      update.mutate(
        {
          id: job.id,
          ...common,
          // PATCH distinguishes "not supplied" from "clear this value".
          // An empty edit must therefore send null, not undefined.
          cronExpression: cronExpression || null,
        },
        { onSuccess: onDone },
      );
    } else {
      create.mutate(
        {
          ...common,
          marketplace,
          type: 'KEYWORD_SWEEP',
          // The create DTO uses omission to represent a manual-only job.
          cronExpression: cronExpression || undefined,
        },
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

        <Field
          label={
            <span className="group relative flex items-center gap-1">
              Cron (optional)
              <span className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-500 hover:bg-slate-300">
                i
              </span>
              <div className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-xs -translate-x-1/2 rounded-md bg-slate-800 px-2.5 py-2 text-[11px] font-normal leading-relaxed text-slate-100 opacity-0 shadow-lg transition-all group-hover:visible group-hover:opacity-100">
                <p className="mb-1"><strong className="text-white">Format:</strong> Sec Min Hour Day Month DayOfWeek</p>
                <p className="mb-1">Leave empty for manual run only.</p>
                <p><strong className="text-white">Example:</strong> <code className="rounded bg-slate-700 px-1 py-0.5 font-mono text-[10px]">0 0 6 * * *</code> (runs daily at 06:00)</p>
                {/* Tooltip Arrow */}
                <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-slate-800"></div>
              </div>
            </span>
          }
        >
          <Input value={cron} onChange={setCron} placeholder="0 0 6 * * *" className="w-32" />
        </Field>
      </div>
      
      <div className="mt-3 flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
          <div
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out ${enabled ? 'bg-blue-600' : 'bg-slate-300'}`}
            onClick={(e) => { e.preventDefault(); setEnabled(!enabled); }}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition duration-200 ease-in-out ${enabled ? 'translate-x-4' : 'translate-x-1'}`}
            />
          </div>
          {enabled ? 'Job is enabled (runs on schedule)' : 'Job is disabled (paused)'}
        </label>
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
            
            {Object.entries(keywordsByNiche).map(([niche, list]) => {
              const allPicked = list.every((k) => picked.has(k.id));
              
              const toggleNiche = () => {
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (allPicked) {
                    list.forEach((k) => next.delete(k.id));
                  } else {
                    list.forEach((k) => next.add(k.id));
                  }
                  return next;
                });
              };

              return (
                <div key={niche} className="mb-2 last:mb-0">
                  <div className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600">
                    <span>{niche}</span>
                    <button
                      type="button"
                      onClick={toggleNiche}
                      className="text-slate-400 hover:text-slate-600 hover:underline"
                    >
                      {allPicked ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="mt-1 flex flex-col px-2">
                    {list.map((k) => (
                      <label
                        key={k.id}
                        className="flex cursor-pointer items-center gap-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
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
                </div>
              );
            })}
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
