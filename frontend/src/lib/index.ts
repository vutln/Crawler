/**
 * Barrel for framework-free helpers. Import from '@/lib'.
 *
 * Everything here is a pure function or a DOM one-liner — no React, no data
 * fetching, no imports from elsewhere in src. That is what makes this folder safe
 * to import from anywhere without thinking about cycles.
 */

// Formatting and class names
export {
  cn,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatRelative,
  formatDateTime,
  formatDuration,
} from './utils';

// Keyword list parsing — pure, so it's the one part of the paste flow that is
// testable without a browser.
export type { ParsedKeyword } from './keywords';
export { normalizeKeyword, parseKeywordList, submittableKeywords } from './keywords';

// Browser download
export { downloadBlob } from './download';
