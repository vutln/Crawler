import type { ReactNode } from 'react';

/** A <label> wrapper, so clicking the caption focuses the control. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}
