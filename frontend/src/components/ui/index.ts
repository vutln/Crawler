/**
 * Barrel for the UI kit. One component per file; import from '@/components/ui'.
 *
 * The barrel is what makes the file layout an implementation detail: consumers
 * never name a primitive's file, so splitting or merging them touches nothing but
 * this list.
 */

// Primitives
export { Button } from './Button';
export { Card } from './Card';
export { Field } from './Field';
export { Input } from './Input';
export { Modal } from './Modal';
export { Select } from './Select';
export { Spinner } from './Spinner';
export { StatTile } from './StatTile';

// Badges — each a pure lookup into a src/domain registry.
export { JobStatusBadge } from './JobStatusBadge';
export { PriceDelta } from './PriceDelta';
export { SiteBadge } from './SiteBadge';

// States
export { EmptyState } from './EmptyState';
export { ErrorState } from './ErrorState';
export { SkeletonRows } from './SkeletonRows';

// Composite
export { Pagination } from './Pagination';
