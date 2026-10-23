/**
 * Generate unique track ID
 */
export function generateTrackId(): string {
  return `track_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Extract filename without extension
 */
export function getTrackNameFromFile(file: File): string {
  return file.name.replace(/\.[^/.]+$/, '');
}

/**
 * Get audio duration using Web Audio API
 */
export function getAudioDuration(url: string): Promise<number> {
  return new Promise(function (resolve, reject): void {
    const audio = new Audio();

    const cleanup = function (): void {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('error', onError);
      audio.src = '';
      audio.load(); // Forces the browser to release the network connection
    };

    const onMeta = function (): void {
      const duration = audio.duration;
      cleanup();
      resolve(duration);
    };

    const onError = function (): void {
      cleanup();
      reject(new Error('Failed to load audio'));
    };

    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('error', onError);
    audio.src = url;
  });
}

/**
 * Decode audio data to AudioBuffer
 */
export async function getAudioBuffer(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextClass();
  const buffer = await audioContext.decodeAudioData(arrayBuffer);
  await audioContext.close();
  return buffer;
}

/**
 * Revoke blob URL if it's a blob
 */
export function revokeBlobUrl(url: string | undefined): void {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fisher-Yates shuffle algorithm
 */
export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
