import { RUN_STATUS } from '@/domain';
import { cn } from '@/lib';
import type { RunStatus } from '@/types';

/** Pure registry lookup — adding a status needs no change here. */
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
