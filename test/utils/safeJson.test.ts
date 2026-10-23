import { describe, it, expect, vi } from 'vitest';
import { safeReplacer, safeStringify } from '@/utils/safeJson';

describe('safeJson', () => {
  describe('safeReplacer', () => {
    it('should return value for non-circular objects', () => {
      const replacer = safeReplacer();
      const obj = { a: 1, b: 'test' };
      expect(replacer('a', 1)).toBe(1);
      expect(replacer('b', 'test')).toBe('test');
    });

    it('should return "[Circular]" for circular references', () => {
      const replacer = safeReplacer();
      const obj = { name: 'circular' } as unknown as { name: string; self: unknown };
      obj.self = obj;

      // First time seeing obj
      expect(replacer('root', obj)).toBe(obj);
      // Second time seeing obj
      expect(replacer('self', obj)).toBe('[Circular]');
    });

    it('should handle nested circular references', () => {
      const replacer = safeReplacer();
      const a = { name: 'a' } as unknown as { name: string; b: unknown };
      const b = { name: 'b', a } as unknown as { name: string; a: unknown };
      a.b = b;

      expect(replacer('a', a)).toBe(a);
      expect(replacer('b', b)).toBe(b);
      expect(replacer('a', a)).toBe('[Circular]');
    });
  });

  describe('safeStringify', () => {
    it('should stringify normal objects', () => {
      const obj = { a: 1, b: { c: 2 } };
      const result = safeStringify(obj, 4);
      expect(result).toContain('    "b"');
      expect(JSON.parse(result)).toEqual(obj);
    });

    it('should stringify circular objects without throwing', () => {
      const obj: any = { name: 'circular' };
      obj.self = obj;

      const result = safeStringify(obj);
      expect(result).toContain('"self": "[Circular]"');
    });

    it('should fall back to String() if stringify fails catastrophically', () => {
      const obj = {
        toJSON: () => {
          throw new Error('catastrophic');
        },
      };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = safeStringify(obj);

      expect(result).toBe('[object Object]');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
