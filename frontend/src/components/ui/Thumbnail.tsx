import { useState } from 'react';
import { cn } from '@/lib';

/**
 * A product image.
 *
 * Fixed width AND height, always: ProductsTable commits to not reflowing, and an
 * unsized image shifts every row as it loads. The box is reserved before the bytes
 * arrive.
 *
 * onError matters as much as the src. These are hot-linked marketplace CDN URLs —
 * they 403, they expire, and imageUrl is nullable — so a missing image is normal
 * and must render as a neutral box rather than a broken-image glyph.
 */
export function Thumbnail({
  src,
  alt,
  size = 32,
  className,
  testId,
}: {
  src: string | null | undefined;
  alt: string;
  size?: number;
  className?: string;
  testId?: string;
}) {
  const [failed, setFailed] = useState(false);

  const box = cn(
    'shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50',
    className,
  );
  const style = { width: size, height: size };

  // The testId rides on both branches so a test can assert the slot is present
  // without asserting the image loaded — which is a network fact, not a UI one.
  if (!src || failed) {
    return <div className={box} style={style} data-testid={testId} aria-hidden />;
  }

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      data-testid={testId}
      // Long product lists are mostly off-screen; don't fetch what isn't visible.
      loading="lazy"
      // Don't leak which products we track to the marketplace's CDN logs.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(box, 'object-cover')}
      style={style}
    />
  );
}
