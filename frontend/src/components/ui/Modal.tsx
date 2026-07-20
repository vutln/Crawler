import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib';

/**
 * A modal dialog, built on the native <dialog> element.
 *
 * Native rather than hand-rolled: showModal() gives focus trapping, inert
 * background, Escape-to-close and a real ::backdrop for free. Re-implementing
 * those over a positioned <div> is how modals end up unusable by keyboard, and
 * this project has no dialog library to reach for.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // Drive the DOM from the `open` prop. showModal() throws if already open, and
    // the `open` ATTRIBUTE renders a non-modal dialog with no backdrop or focus
    // trap — so it must be showModal(), not <dialog open>.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-testid={testId}
      // Fires for Escape as well as close() — so the parent's state can't drift out
      // of sync with the DOM when the user dismisses it without touching our buttons.
      onClose={onClose}
      // The backdrop is part of the dialog's own box, so a click on it targets the
      // dialog itself; clicks on the content target a child. That comparison is the
      // whole click-outside-to-close implementation.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'w-[min(42rem,calc(100vw-2rem))] rounded-lg border border-slate-200 p-0 shadow-xl',
        'backdrop:bg-slate-900/40',
        /**
         * m-auto is what centres this, and it is not optional.
         *
         * A modal <dialog> is `position: fixed; inset: 0` with `margin: auto` in the
         * UA stylesheet — the auto margins are the entire centring mechanism. But
         * Tailwind's preflight sets `margin: 0` on every element, so the dialog
         * collapses to the inset origin and renders in the top-left corner.
         * Measured: margin computed to 0px and the box sat at x=0 y=0.
         */
        'm-auto',
        // <dialog> is display:none until opened; open:flex avoids a flash of layout.
        'open:flex open:flex-col',
        className,
      )}
    >
      <header className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 text-[11px] text-slate-500">{description}</p>}
      </header>

      <div className="p-4">{children}</div>
    </dialog>
  );
}
