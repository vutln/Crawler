import type { RunStatus } from '@/types/api';

/** Same exhaustiveness contract as MARKETPLACE. */
export interface RunStatusMeta {
  label: string;
  badgeClass: string;
  /**
   * Work still outstanding. Drives polling cadence and cancellability.
   * A flag rather than an ACTIVE_STATUSES array so a new in-flight status can't
   * be silently omitted and left looking stuck.
   */
  isActive: boolean;
}

export const RUN_STATUS: Record<RunStatus, RunStatusMeta> = {
  QUEUED: {
    label: 'Queued',
    badgeClass: 'bg-slate-100 text-slate-700',
    isActive: true,
  },
  RUNNING: {
    label: 'Running',
    badgeClass: 'bg-blue-100 text-blue-800 animate-pulse',
    isActive: true,
  },
  SUCCEEDED: {
    label: 'Succeeded',
    badgeClass: 'bg-green-100 text-green-800',
    isActive: false,
  },
  FAILED: {
    label: 'Failed',
    badgeClass: 'bg-red-100 text-red-800',
    isActive: false,
  },
  CANCELLED: {
    label: 'Cancelled',
    badgeClass: 'bg-slate-100 text-slate-500',
    isActive: false,
  },
  BLOCKED: {
    // Purple, not red: the site refused us. Not a bug, and a different fix.
    label: 'Blocked',
    badgeClass: 'bg-purple-100 text-purple-800',
    isActive: false,
  },
};

// Derived — never hand-maintain.

export const RUN_STATUSES = Object.keys(RUN_STATUS) as RunStatus[];

export const RUN_STATUS_OPTIONS: Array<{ value: RunStatus; label: string }> =
  RUN_STATUSES.map((value) => ({ value, label: RUN_STATUS[value].label }));

export const ACTIVE_STATUSES: RunStatus[] = RUN_STATUSES.filter((s) => RUN_STATUS[s].isActive);

export const isActiveStatus = (s: RunStatus): boolean => RUN_STATUS[s].isActive;

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && value in RUN_STATUS;
}
