/**
 * Save a Blob to the user's disk.
 *
 * There is no browser API for "download this bytes I already have", so the
 * standard trick is a temporary object URL behind a synthetic anchor click.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Firefox requires the anchor to be in the document for a synthetic click to
  // trigger a download; Chrome doesn't care. Appending satisfies both.
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Not optional: an object URL pins its Blob in memory for the lifetime of the
  // document, so skipping this leaks the whole export every time someone clicks.
  // Deferred because revoking synchronously can cancel the download in Safari —
  // the click is dispatched, but the fetch of the URL happens after this tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
