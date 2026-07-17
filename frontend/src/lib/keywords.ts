/**
 * Parse a pasted keyword list.
 *
 * Mirrors KeywordsService.normalizeText on the server — trim, collapse internal
 * whitespace, lowercase. Duplicated deliberately rather than shared: this is
 * ADVISORY, for showing the user what will happen before they submit. The server's
 * copy is the authority, because only it can see the unique index and a concurrent
 * tab. If the two ever disagree the server wins and the response reports the truth.
 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface ParsedKeyword {
  text: string;
  /** Repeated within this paste — the later occurrence is dropped. */
  duplicate: boolean;
  /** Already in the keyword list. The server will skip it; that is not an error. */
  existing: boolean;
}

/**
 * Split on newlines AND commas: people paste a spreadsheet column, a CSV cell, or
 * a hand-typed comma list, and all three should just work.
 *
 * Order is preserved — a paste that comes back reordered looks broken.
 */
export function parseKeywordList(raw: string, existing: readonly string[] = []): ParsedKeyword[] {
  const known = new Set(existing.map(normalizeKeyword));
  const seen = new Set<string>();
  const out: ParsedKeyword[] = [];

  for (const chunk of raw.split(/[\n,]/)) {
    const text = normalizeKeyword(chunk);
    if (!text) continue; // blank lines are noise, not input

    const duplicate = seen.has(text);
    seen.add(text);
    out.push({ text, duplicate, existing: known.has(text) });
  }

  return out;
}

/** What will actually be sent: deduped within the paste, existing ones included (the server skips them). */
export function submittableKeywords(parsed: readonly ParsedKeyword[]): string[] {
  return parsed.filter((k) => !k.duplicate).map((k) => k.text);
}
