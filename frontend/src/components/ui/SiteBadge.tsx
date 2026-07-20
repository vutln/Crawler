import { MARKETPLACE } from '@/domain';
import { cn } from '@/lib';
import type { Marketplace } from '@/types';

/** Pure registry lookup — adding a marketplace needs no change here. */
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
