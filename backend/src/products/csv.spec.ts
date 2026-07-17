import { csvCell, csvRow, UTF8_BOM } from './csv';

describe('csvCell', () => {
  it.each([
    ['plain text is left alone', 'Canon AE-1', 'Canon AE-1'],
    ['numbers pass through', 149.5, '149.5'],
    ['booleans pass through', true, 'true'],
    ['null becomes empty', null, ''],
    ['undefined becomes empty', undefined, ''],
    ['zero is not blank', 0, '0'],
    ['false is not blank', false, 'false'],
  ])('%s', (_label, input, expected) => {
    expect(csvCell(input as string)).toBe(expected);
  });

  describe('quoting', () => {
    it.each([
      ['a comma', 'Keyboard, 75% layout', '"Keyboard, 75% layout"'],
      ['a newline', 'Line one\nLine two', '"Line one\nLine two"'],
      ['a carriage return', 'a\rb', '"a\rb"'],
    ])('quotes a value containing %s', (_label, input, expected) => {
      expect(csvCell(input)).toBe(expected);
    });

    it('doubles embedded quotes, and wraps the result', () => {
      expect(csvCell('The "Best" Mug')).toBe('"The ""Best"" Mug"');
    });

    it('leaves an apostrophe alone — it is not a CSV metacharacter', () => {
      expect(csvCell("Dave's Camera")).toBe("Dave's Camera");
    });
  });

  /**
   * CSV INJECTION — the reason this module exists rather than a template string.
   *
   * Product titles are attacker-controlled: anyone can list an item called
   * `=HYPERLINK("http://evil","Click")`, and this project collects it, stores it,
   * and hands it to an operator who opens the CSV in Excel. Unescaped, that cell
   * is not text — it is a formula that runs on their machine.
   *
   * The apostrophe prefix is what Excel uses to force text; it strips it on
   * display, so the operator still reads the real title.
   */
  describe('formula injection', () => {
    it.each([
      ['equals', '=HYPERLINK("http://evil","Click")'],
      ['plus', '+1+1'],
      ['minus', '-1+1'],
      ['at', '@SUM(A1:A9)'],
      ['tab', '\tcmd'],
      ['carriage return', '\rcmd'],
    ])('neutralizes a cell starting with %s', (_label, input) => {
      expect(csvCell(input).replace(/^"/, '')).toMatch(/^'/);
    });

    it("prefixes BEFORE quoting, so the apostrophe stays inside the quotes", () => {
      // Order matters: quote-then-prefix would put the ' outside the quotes, where
      // Excel ignores it and the formula runs anyway.
      expect(csvCell('=cmd|"/c calc"!A1')).toBe(`"'=cmd|""/c calc""!A1"`);
    });

    it('does not touch a legitimate title that merely contains an equals sign', () => {
      // Only a LEADING metacharacter is dangerous; mangling the rest would corrupt
      // real data for no gain.
      expect(csvCell('Adapter 5V=2A')).toBe('Adapter 5V=2A');
    });

    it('does not mangle a negative number into a formula-escaped string', () => {
      // Worth knowing: -5 is legitimately formula-shaped, so it is escaped. Price
      // columns are non-negative, and the alternative — trusting a leading minus —
      // is how the guard gets bypassed.
      expect(csvCell(-5)).toBe("'-5");
    });
  });
});

describe('csvRow', () => {
  it('joins with commas and terminates with CRLF per RFC 4180', () => {
    expect(csvRow(['a', 'b', 'c'])).toBe('a,b,c\r\n');
  });

  it('keeps empty columns positional', () => {
    // A dropped column would silently shift every later field into the wrong header.
    expect(csvRow(['a', null, undefined, 'd'])).toBe('a,,,d\r\n');
  });

  it('escapes each cell independently', () => {
    expect(csvRow(['Mug, large', '=cmd', 12.5])).toBe(`"Mug, large",'=cmd,12.5\r\n`);
  });
});

describe('UTF8_BOM', () => {
  /**
   * Without this Excel reads the file in the system codepage and every é, –, ™ or
   * CJK character in a marketplace title becomes mojibake. It is one character and
   * it decides whether the export is usable.
   */
  it('is the UTF-8 BOM', () => {
    expect(UTF8_BOM).toBe('﻿');
    expect(Buffer.from(UTF8_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
