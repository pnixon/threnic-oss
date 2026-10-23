import { describe, it, expect } from 'vitest';
import { needsAudioResume } from './audioContextResume';

const ctx = (state: string) => ({ state }) as unknown as BaseAudioContext;

describe('needsAudioResume', () => {
  it('resumes from suspended and from the iOS-only interrupted state', () => {
    expect(needsAudioResume(ctx('suspended'))).toBe(true);
    expect(needsAudioResume(ctx('interrupted'))).toBe(true);
  });

  it('leaves running / closed / missing contexts alone', () => {
    expect(needsAudioResume(ctx('running'))).toBe(false);
    expect(needsAudioResume(ctx('closed'))).toBe(false);
    expect(needsAudioResume(null)).toBe(false);
    expect(needsAudioResume(undefined)).toBe(false);
  });
});
