import { describe, it, expect } from 'vitest';
import { parseJson } from './loader';

describe('lyricsLoader', () => {
  it('parses valid JSON lyrics', () => {
    const json = JSON.stringify([
      { text: 'Hello', start: 0, end: 1 },
      { text: 'World', start: 1, end: 2 },
    ]);
    const result = parseJson(json);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Hello');
  });

  it('handles nested word structures', () => {
    const json = JSON.stringify([
      {
        text: 'Line 1',
        start: 0,
        end: 2,
        words: [
          { text: 'Line', start: 0, end: 1 },
          { text: '1', start: 1, end: 2 },
        ],
      },
    ]);
    const result = parseJson(json);
    expect(result).toHaveLength(1);
    expect(result[0].words).toBeDefined();
    expect(result[0].words).toHaveLength(2);
  });

  it('throws error on invalid JSON', () => {
    expect(() => parseJson('{ invalid }')).toThrow();
  });
});
