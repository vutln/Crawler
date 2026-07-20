/**
 * Barrel for the API types. Import from '@/types'.
 *
 * A wildcard here, where every other barrel in this project lists its exports by
 * name. The reason: ./api is ALREADY a hand-curated list — it exists precisely to
 * name the slice of the generated schema this app uses. Re-listing those names
 * here would be a second copy of that curation, and the copy would drift.
 *
 * `export type *` and not `export *`: these are types only, and verbatimModuleSyntax
 * would otherwise emit a runtime import for a module that erases to nothing.
 */
export type * from './api';
