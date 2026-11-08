import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from './csv';

describe('csvCell', () => {
  it('leaves plain values bare and writes null as an empty field', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(null)).toBe('');
  });

  it('quotes a field with a quote, comma, CR or LF, doubling inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });

  it("prefixes a ' to a field starting with =, +, - or @, before quoting", () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell(-1)).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  });
});

describe('csvRow', () => {
  it('joins escaped cells with commas', () => {
    expect(csvRow([1, 'a,b', null, false])).toBe('1,"a,b",,false');
  });
});
