/**
 * RFC 4180 CSV encoding. Ten lines, no dependency.
 *
 * Deliberately hand-rolled rather than pulling in fast-csv/papaparse: the whole
 * job is quoting and escaping, the project already keeps pure string helpers in
 * normalize.ts, and a library would bury the one thing that actually matters here
 * — formula injection — behind a config flag nobody reads.
 */

/** Quote only when required: a comma, a quote, or a newline inside the value. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Leading characters that make Excel and Google Sheets treat a cell as a FORMULA
 * rather than text.
 *
 * This is the reason this file exists. Product titles are attacker-controlled —
 * anyone can list an item on eBay called `=HYPERLINK("http://evil","Click")`, and
 * we collect it, store it, and hand it to an operator who opens the export in
 * Excel. At that point it is not a string in a cell; it is a live formula running
 * on their machine. `@` and tab/CR are included because Excel accepts them as
 * formula starters too.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell.
 *
 * Neutralizes a formula by prefixing an apostrophe, which Excel strips on display
 * — so the operator sees the real title and the spreadsheet treats it as text.
 * Note the order: prefix FIRST, then quote, or the apostrophe lands outside the
 * quotes and does nothing.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';

  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;

  return NEEDS_QUOTING.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV row, CRLF-terminated per RFC 4180 (and what Excel expects). */
export function csvRow(values: Array<string | number | boolean | null | undefined>): string {
  return values.map(csvCell).join(',') + '\r\n';
}

/**
 * UTF-8 byte-order mark.
 *
 * Without it Excel decodes the file as the system's legacy codepage and every
 * accented or CJK product title becomes mojibake — which, for a marketplace
 * dataset, is most of them. This single character decides whether the export is
 * usable, so it is written before anything else.
 */
export const UTF8_BOM = '﻿';
