import { Card } from './Card';

export function StatTile({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string | number;
  hint?: string;
  testId?: string;
}) {
  return (
    <Card className="p-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      {/* tnum: tabular figures, so a polled number doesn't jitter the layout. */}
      <div className="tnum mt-1 text-2xl font-semibold text-slate-900" data-testid={testId}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
    </Card>
  );
}
