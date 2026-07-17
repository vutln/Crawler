import { Link } from 'react-router-dom';
import { Button } from './Button';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: { label: string; to?: string; onClick?: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-sm text-xs text-slate-500">{description}</p>}
      {action &&
        (action.to ? (
          <Link
            to={action.to}
            className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            {action.label}
          </Link>
        ) : (
          <Button className="mt-2" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  );
}
