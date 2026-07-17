/** Table-shaped placeholder: <tr>s, so it drops straight into a <tbody>. */
export function SkeletonRows({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-t border-slate-100">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-3 py-2">
              <div className="h-3 animate-pulse rounded bg-slate-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
