/**
 * Repair of the H.264 decoder configuration (avcC record) a browser's
 * VideoEncoder hands out in `decoderConfig.description`.
 *
 * WHY: Firefox's encoder emits a malformed record. Each parameter set carries
 * its NAL header byte twice (`67 67 64 00 34 …` instead of `67 64 00 34 …`)
 * and the reserved bits are left at zero. The muxer writes the record into the
 * MP4 as-is, so the file's `avcC` box describes a stream that does not exist.
 * ffmpeg recovers from the parameter sets repeated inside the keyframes (with
 * "sps_id out of range" errors); stricter players and hardware decoders that
 * trust the box do not have to.
 *
 * The first keyframe carries the real SPS and PPS, so the record is rebuilt
 * from those. A record that is already well formed is returned untouched.
 */

const NAL_SPS = 7;
const NAL_PPS = 8;

/** Profiles whose avcC record carries chroma format and bit depth fields. */
const HIGH_PROFILES = new Set([100, 110, 122, 144]);

interface ParsedAvcC {
  lengthSize: number;
  reservedBitsSet: boolean;
  sps: Uint8Array[];
  pps: Uint8Array[];
}

const nalType = (nal: Uint8Array): number => (nal.length > 0 ? nal[0] & 0x1f : -1);

function parseAvcC(d: Uint8Array): ParsedAvcC | null {
  if (d.length < 7 || d[0] !== 1) return null;
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  let p = 6;
  const readSets = (count: number, into: Uint8Array[]): boolean => {
    for (let i = 0; i < count; i++) {
      if (p + 2 > d.length) return false;
      const len = (d[p] << 8) | d[p + 1];
      p += 2;
      if (len === 0 || p + len > d.length) return false;
      into.push(d.subarray(p, p + len));
      p += len;
    }
    return true;
  };
  if (!readSets(d[5] & 0x1f, sps)) return null;
  if (p >= d.length) return null;
  if (!readSets(d[p++], pps)) return null;
  return {
    lengthSize: (d[4] & 0x03) + 1,
    reservedBitsSet: (d[4] & 0xfc) === 0xfc && (d[5] & 0xe0) === 0xe0,
    sps,
    pps,
  };
}

function isWellFormed(d: Uint8Array, parsed: ParsedAvcC): boolean {
  if (!parsed.reservedBitsSet || parsed.sps.length === 0 || parsed.pps.length === 0) return false;
  const first = parsed.sps[0];
  // The record's profile/compatibility/level bytes repeat the first SPS's.
  if (first.length < 4 || first[1] !== d[1] || first[2] !== d[2] || first[3] !== d[3]) return false;
  return (
    parsed.sps.every((s) => nalType(s) === NAL_SPS) &&
    parsed.pps.every((s) => nalType(s) === NAL_PPS)
  );
}

/** Split a length-prefixed (AVCC) access unit into its NAL units. */
function splitLengthPrefixed(data: Uint8Array, lengthSize: number): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let p = 0;
  while (p + lengthSize <= data.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + data[p + i];
    p += lengthSize;
    if (len === 0 || p + len > data.length) break;
    nals.push(data.subarray(p, p + len));
    p += len;
  }
  return nals;
}

/** A parameter set whose header byte was written twice, with the copy removed. */
function dropDuplicatedHeader(nal: Uint8Array, type: number): Uint8Array | null {
  if (nal.length > 2 && nal[0] === nal[1] && nalType(nal) === type) return nal.subarray(1);
  return null;
}

/**
 * chroma_format_idc and the bit depths of a High-profile SPS, for the fields
 * the avcC record appends for those profiles. Null if the SPS is too short.
 */
function readHighProfileFields(
  sps: Uint8Array,
): { chroma: number; lumaDepth: number; chromaDepth: number } | null {
  // Strip emulation prevention bytes (00 00 03 → 00 00).
  const rbsp: number[] = [];
  for (let i = 0; i < sps.length; i++) {
    if (i >= 2 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    rbsp.push(sps[i]);
  }
  let bit = 32; // NAL header + profile_idc + constraint flags + level_idc
  const total = rbsp.length * 8;
  const readBit = (): number => {
    if (bit >= total) throw new RangeError('SPS too short');
    const v = (rbsp[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return v;
  };
  const readUE = (): number => {
    let zeros = 0;
    while (readBit() === 0) {
      if (++zeros > 31) throw new RangeError('bad exp-golomb code');
    }
    let v = 1;
    for (let i = 0; i < zeros; i++) v = v * 2 + readBit();
    return v - 1;
  };
  try {
    readUE(); // seq_parameter_set_id
    const chroma = readUE();
    if (chroma === 3) readBit(); // separate_colour_plane_flag
    const lumaDepth = readUE();
    const chromaDepth = readUE();
    if (chroma > 3 || lumaDepth > 6 || chromaDepth > 6) return null;
    return { chroma, lumaDepth, chromaDepth };
  } catch {
    return null;
  }
}

function buildAvcC(sps: Uint8Array[], pps: Uint8Array[], lengthSize: number): Uint8Array {
  const first = sps[0];
  const bytes: number[] = [1, first[1], first[2], first[3], 0xfc | (lengthSize - 1)];
  bytes.push(0xe0 | sps.length);
  for (const s of sps) bytes.push(s.length >> 8, s.length & 0xff, ...s);
  bytes.push(pps.length);
  for (const s of pps) bytes.push(s.length >> 8, s.length & 0xff, ...s);
  if (HIGH_PROFILES.has(first[1])) {
    const f = readHighProfileFields(first);
    if (f) bytes.push(0xfc | f.chroma, 0xf8 | f.lumaDepth, 0xf8 | f.chromaDepth, 0);
  }
  return new Uint8Array(bytes);
}

/**
 * Return a corrected avcC record, or null when `description` is already well
 * formed or cannot be repaired (the caller then keeps the original).
 *
 * @param description the encoder's `decoderConfig.description`
 * @param keyframe    the encoded keyframe that came with it (length-prefixed)
 */
export function repairAvcDescription(
  description: Uint8Array,
  keyframe: Uint8Array,
): Uint8Array | null {
  const parsed = parseAvcC(description);
  if (!parsed) return null;
  if (isWellFormed(description, parsed)) return null;

  // Preferred source: the parameter sets the encoder put in the keyframe.
  const nals = splitLengthPrefixed(keyframe, parsed.lengthSize);
  let sps = nals.filter((n) => nalType(n) === NAL_SPS);
  let pps = nals.filter((n) => nalType(n) === NAL_PPS);

  // Otherwise undo the known damage in the record itself.
  if (sps.length === 0 || pps.length === 0) {
    const fixedSps = parsed.sps.map((s) => dropDuplicatedHeader(s, NAL_SPS) ?? s);
    const fixedPps = parsed.pps.map((s) => dropDuplicatedHeader(s, NAL_PPS) ?? s);
    sps = fixedSps.filter((s) => nalType(s) === NAL_SPS);
    pps = fixedPps.filter((s) => nalType(s) === NAL_PPS);
  }

  if (sps.length === 0 || pps.length === 0 || sps.length > 31 || pps.length > 255) return null;
  if (sps.some((s) => s.length < 4 || s.length > 0xffff) || pps.some((s) => s.length > 0xffff)) {
    return null;
  }
  return buildAvcC(sps, pps, parsed.lengthSize);
}
