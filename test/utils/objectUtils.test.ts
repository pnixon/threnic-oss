import { describe, it, expect } from 'vitest';
import { getNestedValue, setNestedValue, shallowEqual, deepEqual } from '@/utils/objectUtils';

describe('objectUtils', () => {
  describe('getNestedValue', () => {
    it('retrieves nested property', () => {
      const obj = { a: { b: { c: 42 } } };
      expect(getNestedValue(obj, 'a.b.c')).toBe(42);
    });

    it('returns null for non-existent path', () => {
      const obj = { a: { b: 42 } };
      expect(getNestedValue(obj, 'a.b.c')).toBe(null);
    });

    it('returns null if obj is null or undefined', () => {
      expect(getNestedValue(null, 'a.b')).toBe(null);
      expect(getNestedValue(undefined, 'a.b')).toBe(null);
    });

    it('handles arrays', () => {
      const obj = { a: [{ b: 1 }, { b: 2 }] };
      expect(getNestedValue(obj, 'a.1.b')).toBe(2);
    });
  });

  describe('setNestedValue', () => {
    it('sets nested property', () => {
      const obj: any = { a: {} };
      setNestedValue(obj, 'a.b.c', 42);
      expect(obj.a.b.c).toBe(42);
    });

    it('creates intermediate objects if they do not exist', () => {
      const obj: any = {};
      setNestedValue(obj, 'x.y.z', 'hello');
      expect(obj.x.y.z).toBe('hello');
    });

    it('shallow copies intermediate objects', () => {
      const initialB = { c: 1, d: 2 };
      const obj: any = { a: { b: initialB } };
      setNestedValue(obj, 'a.b.c', 42);
      expect(obj.a.b.c).toBe(42);
      expect(obj.a.b.d).toBe(2);
      expect(obj.a.b).not.toBe(initialB); // Reference changed
    });

    it('preserves an array intermediate when the path indexes into it', () => {
      // Regression: a numeric-index path must NOT clobber the array into a plain
      // object (which would break .map/.length/[i] readers downstream, e.g. the
      // GLSL guest channels[] keyframe path glsl.channels.0.intensityReactive).
      const obj: any = { glsl: { channels: [{ intensity: 1 }, { intensity: 1 }] } };
      setNestedValue(obj, 'glsl.channels.0.intensity', 0.5);
      expect(Array.isArray(obj.glsl.channels)).toBe(true);
      expect(obj.glsl.channels.length).toBe(2);
      expect(obj.glsl.channels[0].intensity).toBe(0.5);
      expect(obj.glsl.channels[1].intensity).toBe(1);
      expect(typeof obj.glsl.channels.map).toBe('function');
    });

    it('creates an array (not object) for a missing integer-indexed segment', () => {
      const obj: any = {};
      setNestedValue(obj, 'items.0.name', 'first');
      expect(Array.isArray(obj.items)).toBe(true);
      expect(obj.items[0].name).toBe('first');
    });
  });

  describe('shallowEqual', () => {
    it('returns true for identical objects', () => {
      const obj = { a: 1 };
      expect(shallowEqual(obj, obj)).toBe(true);
    });

    it('returns true for equal shallow objects', () => {
      expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    });

    it('returns false for different values', () => {
      expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('returns false for different keys', () => {
      expect(shallowEqual({ a: 1 }, { b: 1 })).toBe(false);
      expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it('returns false for nested objects that are distinct references', () => {
      expect(shallowEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(false);
    });
  });

  describe('deepEqual', () => {
    it('returns true for identical objects', () => {
      const obj = { a: { b: { c: 1 } } };
      expect(deepEqual(obj, obj)).toBe(true);
    });

    it('returns true for deeply equal objects', () => {
      expect(deepEqual({ a: { b: { c: 1 } }, d: 2 }, { a: { b: { c: 1 } }, d: 2 })).toBe(true);
    });

    it('returns false for deeply different objects', () => {
      expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    });

    it('returns true for deeply equal arrays', () => {
      expect(deepEqual([1, 2, [3, 4]], [1, 2, [3, 4]])).toBe(true);
    });
  });
});
