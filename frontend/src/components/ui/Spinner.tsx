import { cn } from '@/lib';

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600',
        className,
      )}
    />
  );
}
