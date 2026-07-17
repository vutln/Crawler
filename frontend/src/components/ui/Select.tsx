import { cn } from '@/lib/utils';

/** Generic over the value type so callers get their own enum back, not `string`. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  testId,
  disabled,
}: {
  value: T | '';
  onChange: (value: T | undefined) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  placeholder?: string;
  className?: string;
  testId?: string;
  /** For values that are fixed after creation — see JobForm's marketplace. */
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}
      data-testid={testId}
      disabled={disabled}
      className={cn(
        'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm',
        'focus:border-slate-500 focus:ring-1 focus:ring-slate-500 focus:outline-none',
        disabled && 'cursor-not-allowed bg-slate-50 text-slate-500',
        className,
      )}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
