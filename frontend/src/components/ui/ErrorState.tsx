import { Button } from './Button';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Unknown error';

  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center" data-testid="error-state">
      <p className="text-sm font-medium text-red-700">Something failed</p>
      <p className="max-w-md text-xs text-slate-600">{message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
