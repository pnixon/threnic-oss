import { describe, it, expect } from 'vitest';
import { repairAvcDescription } from './avcDescription';

const hex = (s: string) => new Uint8Array(s.split(/\s+/).map((b) => parseInt(b, 16)));

// Captured from Firefox 160's VideoEncoder (avc1.640034, 1920×1080).
const FIREFOX_DESCRIPTION = hex(
  '01 64 00 34 03 01 00 1a 67 67 64 00 34 ac d9 40 78 02 27 e5 84 00 00 03 00 04 00 7a 12 00 3c 60 c6 58 01 00 06 68 68 eb ec b2 2c',
);
const SPS = hex('67 64 00 34 ac d9 40 78 02 27 e5 84 00 00 03 00 04 00 7a 12 00 3c 60 c6 58');
const PPS = hex('68 eb ec b2 2c');
const IDR = hex('65 88 84 00 33 ff');

const lengthPrefixed = (...nals: Uint8Array[]) => {
  const out: number[] = [];
  for (const n of nals) out.push(0, 0, n.length >> 8, n.length & 0xff, ...n);
  return new Uint8Array(out);
};

const GOOD_DESCRIPTION = new Uint8Array([
  1,
  0x64,
  0x00,
  0x34,
  0xff,
  0xe1,
  0,
  SPS.length,
  ...SPS,
  1,
  0,
  PPS.length,
  ...PPS,
  0xfd,
  0xf8,
  0xf8,
  0,
]);

describe('repairAvcDescription', () => {
  it('rebuilds the Firefox record from the keyframe parameter sets', () => {
    const repaired = repairAvcDescription(FIREFOX_DESCRIPTION, lengthPrefixed(SPS, PPS, IDR));
    expect(repaired).toEqual(GOOD_DESCRIPTION);
  });

  it('removes the duplicated header bytes when the keyframe has no parameter sets', () => {
    const repaired = repairAvcDescription(FIREFOX_DESCRIPTION, lengthPrefixed(IDR));
    expect(repaired).toEqual(GOOD_DESCRIPTION);
  });

  it('leaves a well formed record alone', () => {
    expect(repairAvcDescription(GOOD_DESCRIPTION, lengthPrefixed(SPS, PPS, IDR))).toBeNull();
    // The High-profile fields are optional in practice; their absence is fine.
    const withoutExt = GOOD_DESCRIPTION.subarray(0, GOOD_DESCRIPTION.length - 4);
    expect(repairAvcDescription(withoutExt, lengthPrefixed(IDR))).toBeNull();
  });

  it('gives up on data that is not an avcC record', () => {
    expect(
      repairAvcDescription(new Uint8Array([0, 0, 0, 1, 0x67]), lengthPrefixed(IDR)),
    ).toBeNull();
    expect(repairAvcDescription(new Uint8Array(0), new Uint8Array(0))).toBeNull();
    // Truncated in the middle of the SPS.
    expect(
      repairAvcDescription(FIREFOX_DESCRIPTION.subarray(0, 20), lengthPrefixed(IDR)),
    ).toBeNull();
  });
});
