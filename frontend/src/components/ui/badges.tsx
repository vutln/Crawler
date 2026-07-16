import { MARKETPLACE } from '@/domain/marketplace';
import { RUN_STATUS } from '@/domain/run-status';
import { cn, formatPercent } from '@/lib/utils';
import type { Marketplace, RunStatus } from '@/types/api';

export function SiteBadge({ marketplace }: { marketplace: Marketplace }) {
  const meta = MARKETPLACE[marketplace];
  return (
    <span
      title={meta.note}
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide',
        meta.badgeClass,
      )}
    >
      {meta.label}
    </span>
  );
}

export function JobStatusBadge({ status }: { status: RunStatus }) {
  const meta = RUN_STATUS[status];
  return (
    <span
      data-testid={`status-${status}`}
      className={cn('inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold', meta.badgeClass)}
    >
      {meta.label}
    </span>
  );
}

/** Down is green: for a price tracker, a drop is good news. */
export function PriceDelta({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;

  return (
    <span
      className={cn(
        'tnum text-xs font-medium',
        value > 0 ? 'text-red-600' : value < 0 ? 'text-green-600' : 'text-slate-500',
      )}
    >
      {formatPercent(value)}
    </span>
  );
}
