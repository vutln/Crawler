import { useState } from 'react';
import { Button, Modal } from '@/components/ui';
import { JobForm } from './JobForm';

/**
 * The "+ New sweep" affordance. The form itself is JobForm, shared with editing so
 * the two can't drift — a create form that offers different fields from the edit
 * form is how a setting becomes unreachable after creation.
 */
export function CreateJobForm() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <Button onClick={() => setOpen(true)} testId="new-job">
        + New sweep
      </Button>

      {/*
        Mounted only while open. <dialog> keeps its children in the DOM either way,
        so leaving it mounted would preserve half-typed state from a dismissed
        dialog and silently reopen with it — and JobForm seeds its state from props
        on first render only.
      */}
      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="New sweep"
          description="A sweep collects keywords on one site. Manage the list in Keywords."
          testId="job-modal"
        >
          <JobForm onDone={() => setOpen(false)} />
        </Modal>
      )}
    </div>
  );
}
