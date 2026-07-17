import { cn, formatPercent } from '@/lib/utils';

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
