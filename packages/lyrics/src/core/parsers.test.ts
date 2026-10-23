import { describe, it, expect } from 'vitest';
import { LyricParsers } from './parsers';

// Ensure crypto.randomUUID exists (happy-dom provides it; guard for safety).
if (typeof crypto === 'undefined') {
  (globalThis as unknown as { crypto: unknown }).crypto = {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substring(2, 9),
  };
} else if (!crypto.randomUUID) {
  (crypto as unknown as { randomUUID: unknown }).randomUUID = () =>
    'test-uuid-' + Math.random().toString(36).substring(2, 9);
}

describe('LyricParsers', () => {
  describe('parseTime', () => {
    it('should parse SS.ms format', () => {
      expect(LyricParsers.parseTime('10.5')).toBe(10.5);
    });

    it('should parse MM:SS.ms format', () => {
      expect(LyricParsers.parseTime('01:30.5')).toBe(90.5);
      expect(LyricParsers.parseTime('1:30,5')).toBe(90.5);
    });

    it('should parse HH:MM:SS.ms format', () => {
      expect(LyricParsers.parseTime('01:01:01.500')).toBe(3661.5);
    });

    it('should return 0 for invalid formats', () => {
      expect(LyricParsers.parseTime('abc')).toBe(0);
      expect(LyricParsers.parseTime('1:2:3:4')).toBe(0);
    });
  });

  describe('detectFormat', () => {
    it('should detect LRC format', () => {
      expect(LyricParsers.detectFormat('[00:01.00]Hello')).toBe('lrc');
    });

    it('should detect SRT format', () => {
      expect(LyricParsers.detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHello')).toBe('srt');
    });

    it('should default to text format', () => {
      expect(LyricParsers.detectFormat('Just some plain text')).toBe('text');
    });
  });

  describe('fromText', () => {
    it('should parse plain text into words', () => {
      const raw = 'Hello world\nThis is a test';
      const words = LyricParsers.fromText(raw);
      expect(words).toHaveLength(6);
      expect(words[0].text).toBe('Hello');
      expect(words[0].isLineStart).toBe(true);
      expect(words[2].text).toBe('This');
      expect(words[2].isLineStart).toBe(true);
    });

    it('should handle stanza starts with double newlines', () => {
      const raw = 'Line 1\n\nLine 2';
      const words = LyricParsers.fromText(raw);
      expect(words[2].text).toBe('Line');
      expect(words[2].isStanzaStart).toBe(true);
    });

    it('should skip lines with no words after splitting', () => {
      const raw = ' \n \n ';
      const words = LyricParsers.fromText(raw);
      expect(words).toHaveLength(0);
    });

    it('should handle multiple newlines correctly', () => {
      const raw = 'A\n\n\nB';
      const words = LyricParsers.fromText(raw);
      expect(words).toHaveLength(2);
      expect(words[1].text).toBe('B');
      expect(words[1].isStanzaStart).toBe(true);
    });

    it('should handle text with only brackets', () => {
      const raw = '[Verse 1]\n[Chorus]';
      const words = LyricParsers.fromText(raw);
      expect(words).toHaveLength(0);
    });

    it('should strip brackets', () => {
      const raw = '[Chorus]\nHello';
      const words = LyricParsers.fromText(raw);
      expect(words).toHaveLength(1);
      expect(words[0].text).toBe('Hello');
    });
  });

  describe('fromLRC', () => {
    it('should parse LRC format with timestamps', () => {
      const raw = '[00:01.00]Hello world\n[00:02.00]Second line';
      const words = LyricParsers.fromLRC(raw);
      expect(words[0].text).toBe('Hello');
      expect(words[0].startTime).toBe(1);
      expect(words[1].text).toBe('world');
      expect(words[1].startTime).toBe(1.1);
      expect(words[2].text).toBe('Second');
      expect(words[2].startTime).toBe(2);
    });

    it('should skip empty LRC content', () => {
      const raw = '[00:01.00]\n[00:02.00]Hello';
      const words = LyricParsers.fromLRC(raw);
      expect(words).toHaveLength(1);
      expect(words[0].text).toBe('Hello');
    });

    it('should handle case with no words for end time calculation', () => {
      const words = LyricParsers.fromLRC('');
      expect(words).toHaveLength(0);
    });

    it('should calculate end times', () => {
      const raw = '[00:01.00]A\n[00:02.00]B';
      const words = LyricParsers.fromLRC(raw);
      expect(words[0].endTime).toBe(2);
      expect(words[1].endTime).toBe(2.5);
    });
  });

  describe('fromSRT', () => {
    it('should parse SRT blocks', () => {
      const raw = `1
00:00:01,000 --> 00:00:02,000
Hello world

2
00:00:03,000 --> 00:00:04,000
Test`;
      const words = LyricParsers.fromSRT(raw);
      expect(words).toHaveLength(3);
      expect(words[0].startTime).toBe(1);
      expect(words[0].endTime).toBe(1.5);
      expect(words[1].startTime).toBe(1.5);
      expect(words[1].endTime).toBe(2);
      expect(words[2].startTime).toBe(3);
    });

    it('should skip malformed SRT blocks', () => {
      const raw = `1
invalid time
Hello`;
      const words = LyricParsers.fromSRT(raw);
      expect(words).toHaveLength(0);
    });

    it('should handle SRT with too few lines', () => {
      const raw = `1
00:01.00`;
      const words = LyricParsers.fromSRT(raw);
      expect(words).toHaveLength(0);
    });

    it('should skip blocks with empty content after bracket stripping', () => {
      const raw = `1
00:00:01,000 --> 00:00:02,000
[Chorus]`;
      const words = LyricParsers.fromSRT(raw);
      expect(words).toHaveLength(0);
    });
  });

  describe('parse', () => {
    it('should route to LRC parser', () => {
      const content = '[00:01.00]Hello';
      const words = LyricParsers.parse(content);
      expect(words[0].startTime).toBe(1);
    });

    it('should route to SRT parser', () => {
      const content = '1\n00:00:01,000 --> 00:00:02,000\nHello';
      const words = LyricParsers.parse(content);
      expect(words[0].startTime).toBe(1);
    });

    it('should route to Text parser by default', () => {
      const content = 'Plain text';
      const words = LyricParsers.parse(content);
      expect(words[0].startTime).toBe(0);
    });
  });
});
