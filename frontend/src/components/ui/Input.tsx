import { cn } from '@/lib/utils';

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      data-testid={testId}
      className={cn(
        'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm',
        'placeholder:text-slate-400 focus:border-slate-500 focus:ring-1 focus:ring-slate-500 focus:outline-none',
        className,
      )}
    />
  );
}
