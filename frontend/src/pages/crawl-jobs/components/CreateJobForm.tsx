import { useState } from 'react';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE,
  MARKETPLACE_OPTIONS,
} from '@/domain/marketplace';
import { useCreateCrawlJob } from '@/hooks/useCrawls';
import type { Marketplace } from '@/types/api';

export function CreateJobForm() {
  const create = useCreateCrawlJob();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [marketplace, setMarketplace] = useState<Marketplace>(DEFAULT_MARKETPLACE);
  const [query, setQuery] = useState('');
  const [cron, setCron] = useState('');
  const [maxPages, setMaxPages] = useState('2');

  const submit = () => {
    create.mutate(
      {
        name: name.trim(),
        marketplace,
        type: 'SEARCH',
        query: query.trim(),
        maxPages: Number(maxPages) || 2,
        maxItems: 100,
        enabled: true,
        ...(cron.trim() && { cronExpression: cron.trim() }),
      },
      {
        onSuccess: () => {
          setName('');
          setQuery('');
          setCron('');
          setOpen(false);
        },
      },
    );
  };

  if (!open) {
    return (
      <div>
        <Button onClick={() => setOpen(true)} testId="new-job">
          + New crawl job
        </Button>
      </div>
    );
  }

  const note = MARKETPLACE[marketplace].note;

  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={setName}
            placeholder="Keyboards on eBay"
            className="w-48"
            testId="job-name"
          />
        </Field>

        <Field label="Site">
          <Select<Marketplace>
            value={marketplace}
            onChange={(v) => v && setMarketplace(v)}
            options={MARKETPLACE_OPTIONS}
            testId="job-marketplace"
          />
        </Field>

        <Field label="Search query">
          <Input
            value={query}
            onChange={setQuery}
            placeholder="mechanical keyboard"
            className="w-48"
            testId="job-query"
          />
        </Field>

        <Field label="Max pages">
          <Input type="number" value={maxPages} onChange={setMaxPages} className="w-20" />
        </Field>

        <Field label="Cron (optional)">
          <Input value={cron} onChange={setCron} placeholder="0 0 6 * * *" className="w-32" />
        </Field>

        <Button
          onClick={submit}
          disabled={!name.trim() || !query.trim() || create.isPending}
          testId="job-submit"
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      {note && <p className="mt-2 text-[11px] text-amber-700">{note}</p>}
    </Card>
  );
}
