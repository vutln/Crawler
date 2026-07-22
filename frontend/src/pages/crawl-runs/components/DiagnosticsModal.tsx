import { useDiagnostics } from '@/hooks';
import { Modal, Spinner, Button, EmptyState } from '@/components/ui';

export function DiagnosticsModal({
  open,
  onClose,
  prefix,
}: {
  open: boolean;
  onClose: () => void;
  prefix: string | undefined;
}) {
  const { data: diagnostics, isLoading, isError } = useDiagnostics(prefix);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run Diagnostics"
      description={`Screenshots and HTML snapshots captured for run ${prefix?.replace('error-run_', '')}.`}
      className="w-[min(50rem,calc(100vw-2rem))]"
    >
      <div className="min-h-[200px]">
        {isLoading && (
          <div className="flex h-full items-center justify-center py-10">
            <Spinner className="h-6 w-6 text-slate-400" />
          </div>
        )}

        {isError && (
          <div className="py-10 text-center text-sm text-red-600">
            Failed to load diagnostics.
          </div>
        )}

        {diagnostics && diagnostics.length === 0 && (
          <EmptyState
            title="No diagnostics found"
            description="The system has not captured any Selenium errors yet."
          />
        )}

        {diagnostics && diagnostics.length > 0 && (
          <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
            {diagnostics.map((file) => (
              <div
                key={file.name}
                className="flex items-center justify-between rounded-md border border-slate-200 p-3 text-sm"
              >
                <div>
                  <div className="font-medium text-slate-900">{file.name}</div>
                  <div className="text-xs text-slate-500">
                    {new Date(file.createdAt).toLocaleString()} • {(file.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    window.open(`/api/diagnostics/${file.name}`, '_blank');
                  }}
                >
                  View
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
