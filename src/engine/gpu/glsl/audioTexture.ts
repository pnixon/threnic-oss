/**
 * audioTexture — source the 512×2 audio channel bytes for GLSL guests.
 *
 * The GLSL-guest audio input is a 512×2 texture: row 0 = FFT magnitudes, row 1 =
 * waveform, both 0-255. `audioStore` already holds exactly these as byte arrays
 * (`fftData`, `timeDomainData`), so no extra analysis is needed — this helper
 * just hands them to GLSLGuestRenderer.uploadAudio, which resamples to 512 wide.
 *
 * Preview pulls live from the store; export passes the per-frame byte arrays the
 * offline AudioAnalyzer already writes into the store, so both paths agree.
 */

import { getAudioState } from '@/engine/stores/audioStore';

interface GuestAudioBytes {
  fft: Uint8Array | null;
  wave: Uint8Array | null;
}

/** Read the current audio bytes from the store (preview path). */
export function guestAudioFromStore(): GuestAudioBytes {
  const s = getAudioState();
  return { fft: s.fftData ?? null, wave: s.timeDomainData ?? null };
}
