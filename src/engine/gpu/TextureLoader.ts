/**
 * TextureLoader — Load images and videos into GPUTexture objects.
 *
 * Supports URLs, Blob, and ImageBitmap sources for images.
 * For videos, uses HTMLVideoElement + copyExternalImageToTexture for
 * per-frame GPU uploads.
 */

export interface LoadedTexture {
  texture: GPUTexture;
  width: number;
  height: number;
}

export interface LoadedVideoTexture extends LoadedTexture {
  video: HTMLVideoElement;
  /** Whether the video has decoded at least one frame */
  ready: boolean;
}

type DebugVideoElement = HTMLVideoElement & {
  webkitPlaysInline?: boolean;
  __debugAC?: AbortController;
};

/**
 * Detect whether a URL points to a video file.
 * Checks both file extensions and MIME-type hints in blob URLs.
 */
export function isVideoUrl(url: string, name?: string): boolean {
  const lowerUrl = url.toLowerCase();
  const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg', '.ogv'];
  if (videoExts.some((ext) => lowerUrl.includes(ext))) return true;
  if (lowerUrl.includes('video/')) return true;
  if (name) {
    const lowerName = name.toLowerCase();
    if (videoExts.some((ext) => lowerName.includes(ext))) return true;
  }
  return false;
}

/**
 * Probe raw bytes for video container magic signatures.
 * Requires at least 12 bytes from the start of the file.
 *
 * Detects: MP4/MOV (ftyp), WebM/MKV (EBML), AVI (RIFF+AVI).
 */
export function hasVideoMagicBytes(header: Uint8Array): boolean {
  if (header.length < 12) return false;
  // MP4/MOV: bytes 4-7 = "ftyp" (0x66747970)
  if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70)
    return true;
  // WebM/MKV: EBML header 0x1A45DFA3
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3)
    return true;
  // AVI: "RIFF" (0x52494646) + "AVI " at offset 8
  if (
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x41 &&
    header[9] === 0x56 &&
    header[10] === 0x49
  )
    return true;
  return false;
}

export class TextureLoader {
  private device: GPUDevice;
  private cache: Map<string, LoadedTexture> = new Map();
  private videoCache: Map<string, LoadedVideoTexture> = new Map();
  /** Track in-flight video loads to avoid duplicate parallel requests */
  private _videoLoadInFlight: Map<string, Promise<LoadedVideoTexture | null>> = new Map();
  /** Cache failed loads to avoid infinite retry loops on requestAnimationFrame */
  private failedUrls: Set<string> = new Set();

  /**
   * Throttle for per-frame error logging.
   * Maps error-type key → last-logged timestamp to prevent console spam
   * from errors that fire every frame (e.g. InvalidStateError during video seek).
   */
  private _errorThrottle: Map<string, number> = new Map();
  private static readonly ERROR_THROTTLE_MS = 2000;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Log a warning at most once per ERROR_THROTTLE_MS for a given key.
   * Returns true if the message was logged (useful for conditional extra work).
   */
  private _throttledWarn(key: string, ...args: unknown[]): boolean {
    const now = performance.now();
    // First occurrence for this key always logs
    if (!this._errorThrottle.has(key)) {
      this._errorThrottle.set(key, now);
      console.warn(...args);
      return true;
    }
    const lastLogged = this._errorThrottle.get(key)!;
    if (now - lastLogged < TextureLoader.ERROR_THROTTLE_MS) return false;
    this._errorThrottle.set(key, now);
    console.warn(...args);
    return true;
  }

  /**
   * Return a previously-cached texture by its cache key, or undefined.
   *
   * The TextureLoader OWNS every texture in its cache — callers must treat the
   * returned texture as borrowed and MUST NOT destroy it (destroying a cached
   * texture leaves a dangling entry that later hands out a destroyed resource,
   * which invalidates any bind group that samples it and blanks the frame).
   */
  getCachedTexture(cacheKey: string): LoadedTexture | undefined {
    return this.cache.get(cacheKey);
  }

  /**
   * Load a texture from a URL (image file or blob URL).
   * Results are cached by URL.
   */
  async loadFromUrl(url: string): Promise<LoadedTexture | null> {
    if (!url) return null; // Reject empty/null URLs
    if (this.failedUrls.has(url)) return null;
    const cached = this.cache.get(url);
    if (cached) return cached;

    // Guard: video URLs must go through loadVideoFromUrl, not here.
    // createImageBitmap will throw InvalidStateError on video blobs.
    if (isVideoUrl(url)) {
      console.info(
        '[TextureLoader] loadFromUrl called with video URL — auto-redirecting to video loader:',
        url.substring(0, 80),
      );
      return this.loadVideoFromUrl(url);
    }

    try {
      let blob: Blob;
      if (url.startsWith('blob:')) {
        blob = await new Promise<Blob>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'blob';
          xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 0) {
              resolve(xhr.response);
            } else {
              reject(new Error(`XHR status ${xhr.status} for ${url}`));
            }
          };
          xhr.onerror = () => reject(new Error(`XHR network error for ${url}`));
          xhr.send();
        });
      } else {
        const response = await fetch(url);
        blob = await response.blob();
      }

      // Double-check: if the fetched blob has a video MIME type, redirect to video pipeline
      if (blob.type.startsWith('video/')) {
        console.info(
          '[TextureLoader] loadFromUrl detected video blob — auto-redirecting to video loader:',
          blob.type,
        );
        return this.loadVideoFromUrl(url);
      }

      return this.loadFromBlob(blob, url);
    } catch (e) {
      this.failedUrls.add(url);
      // Blob URLs are expected to fail after revocation (e.g. track switch) — warn only
      if (url.startsWith('blob:')) {
        console.warn(
          '[TextureLoader] Blob URL no longer valid (likely revoked):',
          url.substring(0, 80),
        );
      } else {
        console.error('[TextureLoader] Failed to load URL:', url, e);
      }
      return null;
    }
  }

  /**
   * Load a texture from a Blob.
   */
  async loadFromBlob(blob: Blob, cacheKey?: string): Promise<LoadedTexture | null> {
    try {
      const bitmap = await createImageBitmap(blob, {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'default',
      });
      const result = this.loadFromBitmap(bitmap);
      bitmap.close();

      if (result && cacheKey) {
        this.cache.set(cacheKey, result);
      }
      return result;
    } catch (e) {
      // createImageBitmap failed — this commonly happens when the blob
      // contains video data (InvalidStateError: source image could not be decoded).
      // Try the video pipeline as a fallback.
      const isInvalidState = e instanceof DOMException && e.name === 'InvalidStateError';

      if (isInvalidState && cacheKey) {
        console.info(
          '[TextureLoader] createImageBitmap failed (InvalidStateError) — trying video pipeline for:',
          cacheKey.substring(0, 80),
        );
        return this.loadVideoFromUrl(cacheKey);
      }

      // Non-InvalidStateError or no URL to fall back to — log and give up
      if (isInvalidState) {
        // InvalidStateError without a cache key — likely a video blob passed
        // without context. Not recoverable, but not a hard error.
        console.warn(
          '[TextureLoader] createImageBitmap failed (video data?) with no cache key:',
          e,
        );
      } else {
        console.error('[TextureLoader] Failed to create bitmap from blob:', e);
      }
      return null;
    }
  }

  /**
   * Load a texture from an ImageBitmap.
   * This is the lowest-level method — all others funnel here.
   */
  loadFromBitmap(bitmap: ImageBitmap): LoadedTexture | null {
    const { width, height } = bitmap;

    // Guard: zero-dimension bitmaps would cause GPU errors
    if (width === 0 || height === 0) {
      console.warn('[TextureLoader] Skipping zero-dimension bitmap:', width, height);
      return null;
    }

    const texture = this.device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        { width, height },
      );
    } catch (e) {
      console.warn('[TextureLoader] Failed to copy bitmap to texture:', e);
      texture.destroy();
      return null;
    }

    return { texture, width, height };
  }

  // -------------------------------------------------------------------
  // Video support
  // -------------------------------------------------------------------

  /**
   * Load a video from a URL. Creates an HTMLVideoElement, waits for the
   * first frame to decode, creates a GPUTexture sized to the video, and
   * uploads the initial frame.
   *
   * Use `updateVideoFrame()` each frame to copy new decoded pixels.
   */
  async loadVideoFromUrl(url: string): Promise<LoadedVideoTexture | null> {
    if (!url) return null; // Reject empty/null URLs
    if (this.failedUrls.has(url)) return null;

    // Return from cache if already loaded
    const cached = this.videoCache.get(url);
    if (cached) return cached;

    // If a load for this URL is already in-flight, await and reuse it
    const inFlight = this._videoLoadInFlight.get(url);
    if (inFlight) return inFlight;

    // Start the load and track it
    const loadPromise = this._doLoadVideo(url);
    this._videoLoadInFlight.set(url, loadPromise);

    try {
      const result = await loadPromise;
      if (!result) {
        this.failedUrls.add(url);
      }
      return result;
    } catch {
      this.failedUrls.add(url);
      return null;
    } finally {
      this._videoLoadInFlight.delete(url);
    }
  }

  /** Internal: actually load a video URL into a texture. */
  private async _doLoadVideo(url: string): Promise<LoadedVideoTexture | null> {
    console.debug(`[TextureLoader] Starting load for video: ${url}`);
    try {
      const video = document.createElement('video');

      // Set crossOrigin only for actual cross-origin requests.
      if (!url.startsWith('blob:') && !url.startsWith('data:')) {
        try {
          const urlObj = new URL(url, window.location.href);
          if (urlObj.origin !== window.location.origin) {
            console.debug(`[TextureLoader] Setting crossOrigin="anonymous" for ${url}`);
            video.crossOrigin = 'anonymous';
          }
        } catch {
          // If URL parsing fails, it's likely a relative path, ignore
        }
      }

      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      (video as DebugVideoElement).webkitPlaysInline = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.preload = 'auto';

      // Log major video events (removable via AbortController on eviction)
      const debugAC = new AbortController();
      const debugEvents = [
        'loadstart',
        'suspend',
        'emptied',
        'stalled',
        'loadedmetadata',
        'loadeddata',
        'canplay',
        'canplaythrough',
        'playing',
        'waiting',
        'error',
      ];
      debugEvents.forEach((evt) => {
        video.addEventListener(
          evt,
          () => {
            console.debug(
              `[TextureLoader] Video event [${evt}] for ${url}. readyState=${video.readyState}`,
            );
          },
          { signal: debugAC.signal },
        );
      });
      // Store controller so destroy() can abort listeners
      (video as DebugVideoElement).__debugAC = debugAC;

      // Wait for at least one frame to be decoded, with a timeout
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        // `keepAttached` = leave the <video> in the DOM after a SUCCESSFUL load.
        // Firefox heavily throttles / repeatedly stalls decoding for a DETACHED
        // (not-in-document) <video>: a looping muted background clip that plays
        // fine on Chrome while detached instead thrashes playing→waiting
        // (readyState 4→1) forever on Firefox, and every readyState<2 window is
        // a frame updateVideoFrame() no-ops → the copy texture goes stale →
        // visible flicker synced to video playback. Chrome sustains a detached
        // video; Firefox does not. So on success we keep the element attached
        // (hidden 1px offscreen, styled below); only the error/timeout-reject
        // paths remove it. evict()/destroy() remove it when the texture is freed.
        const cleanup = (keepAttached = false) => {
          video.removeEventListener('loadeddata', onLoaded);
          video.removeEventListener('canplay', onLoaded);
          video.removeEventListener('error', onError);
          clearTimeout(timer);
          if (!keepAttached && video.parentNode) {
            video.parentNode.removeChild(video);
          }
        };

        const onLoaded = () => {
          if (settled) return;
          settled = true;
          console.debug(`[TextureLoader] Video signaled ready via event for ${url}`);
          cleanup(true);
          resolve();
        };

        const onError = () => {
          if (settled) return;
          settled = true;
          cleanup();
          const mediaErr = video.error;
          const code = mediaErr?.code ?? '?';
          const msg = mediaErr?.message ?? 'unknown';
          console.warn(`[TextureLoader] Video failed to load (code=${code}, msg=${msg}):`, url);
          reject(
            new Error(
              `Video failed to load (MediaError code=${code}: ${msg}): ${url.substring(0, 100)}`,
            ),
          );
        };

        // Timeout to avoid indefinite hangs
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // Don't reject on timeout — if readyState is at least 1 (metadata),
          // try to proceed anyway; the frame copy will no-op until ready.
          if (video.readyState >= 1) {
            cleanup(true); // proceeding → keep attached (Firefox anti-stall)
            console.warn(
              `[TextureLoader] Video load timeout, but readyState=${video.readyState}. Proceeding for ${url}`,
            );
            resolve();
          } else {
            cleanup(); // hard fail → detach
            console.error(
              `[TextureLoader] Video load TIMEOUT (readyState=${video.readyState}) for ${url}`,
            );
            reject(
              new Error(
                `Video load timed out (readyState=${video.readyState}): ${url.substring(0, 100)}`,
              ),
            );
          }
        }, 10_000);

        video.addEventListener('loadeddata', onLoaded, { once: true });
        video.addEventListener('canplay', onLoaded, { once: true });
        video.addEventListener('error', onError, { once: true });

        // Temporarily append the video to the DOM to ensure the browser schedules
        // the media loading & decoding task, especially under strict autoplay/resource policies.
        video.style.position = 'absolute';
        video.style.width = '1px';
        video.style.height = '1px';
        video.style.opacity = '0';
        video.style.pointerEvents = 'none';
        video.style.left = '-9999px';
        video.style.top = '-9999px';
        document.body.appendChild(video);

        video.src = url;
        video.load(); // Explicitly call load() to start buffering

        if (video.readyState >= 2) {
          console.debug(
            `[TextureLoader] Video already ready (readyState=${video.readyState}) immediately for ${url}`,
          );
          settled = true;
          cleanup(true);
          resolve();
        }
      });

      console.debug(
        `[TextureLoader] Creating GPUTexture for video: ${url} (${video.videoWidth}x${video.videoHeight})`,
      );
      const width = video.videoWidth || 1920;
      const height = video.videoHeight || 1080;

      // Create a GPUTexture that we'll update every frame
      const texture = this.device.createTexture({
        label: `video-texture-${url.substring(0, 40)}`,
        size: { width, height },
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Upload the initial frame (guard against readyState < 2 or zero-size video)
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        try {
          this.device.queue.copyExternalImageToTexture(
            { source: video },
            { texture },
            { width, height },
          );
        } catch (e) {
          // Initial frame copy can fail transiently (InvalidStateError) if
          // the decoder hasn't fully produced a frame despite readyState >= 2.
          // updateVideoFrame() will retry each render frame.
          console.warn(
            `[TextureLoader] Initial video frame upload failed (readyState=${video.readyState}, ` +
              `videoWidth=${video.videoWidth}, paused=${video.paused}):`,
            e instanceof Error ? e.message : e,
          );
        }
      } else {
        console.debug(
          `[TextureLoader] Skipping initial frame upload — video not ready ` +
            `(readyState=${video.readyState}, videoWidth=${video.videoWidth}, videoHeight=${video.videoHeight})`,
        );
      }

      // Start playback (muted, so autoplay is allowed)
      video.play().catch(() => {
        // Autoplay blocked — user interaction needed; frame updates still work via seeking
      });

      const result: LoadedVideoTexture = { texture, width, height, video, ready: true };
      this.videoCache.set(url, result);
      return result;
    } catch (e) {
      if (url.startsWith('blob:')) {
        console.warn(
          '[TextureLoader] Video blob URL no longer valid (likely revoked):',
          url.substring(0, 80),
        );
      } else {
        console.warn('[TextureLoader] Failed to load video URL:', url.substring(0, 100), e);
      }
      return null;
    }
  }

  /**
   * Copy the current video frame to the GPU texture.
   * Call this every render frame for smooth video playback.
   * No-ops if the video isn't ready yet (readyState < 2).
   */
  updateVideoFrame(vt: LoadedVideoTexture): void {
    const video = vt.video;
    if (!video || video.readyState < 2) return;

    // Additional guard: videoWidth/videoHeight can be 0 during codec re-init
    // even when readyState >= 2, which causes InvalidStateError.
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: video },
        { texture: vt.texture },
        { width: vt.width, height: vt.height },
      );
    } catch (e) {
      // Throttled warning — fires at most once per 2s to avoid console flood
      // since this method runs every animation frame.
      this._throttledWarn(
        'updateVideoFrame',
        `[TextureLoader] updateVideoFrame failed (readyState=${video.readyState}, ` +
          `videoWidth=${video.videoWidth}x${video.videoHeight}, ` +
          `currentTime=${video.currentTime.toFixed(2)}, paused=${video.paused}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // -------------------------------------------------------------------
  // Zero-copy external texture (importExternalTexture)
  // -------------------------------------------------------------------

  /**
   * Check if the current device supports importExternalTexture.
   */
  supportsExternalTexture(): boolean {
    return typeof this.device.importExternalTexture === 'function';
  }

  /**
   * Import a video element as a GPUExternalTexture (zero-copy).
   *
   * IMPORTANT: The returned GPUExternalTexture is only valid for the
   * current compositor frame. You MUST call this every animation frame
   * to get a fresh external texture — the previous one is automatically
   * invalidated by the browser.
   *
   * This avoids the per-frame copyExternalImageToTexture() call entirely,
   * letting the browser's hardware video decoder share its output buffer
   * directly with WebGPU.
   *
   * @returns GPUExternalTexture or null if video isn't ready / not supported
   */
  importExternalVideo(video: HTMLVideoElement): GPUExternalTexture | null {
    if (!this.supportsExternalTexture()) return null;
    if (video.readyState < 2) return null;

    try {
      return this.device.importExternalTexture({ source: video });
    } catch {
      // Can fail transiently during seek or if video is not playing
      return null;
    }
  }

  /**
   * Create a 1x1 placeholder texture (used when no image is loaded).
   */
  createPlaceholder(r = 0, g = 0, b = 0, a = 255): LoadedTexture {
    const texture = this.device.createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.writeTexture(
      { texture },
      new Uint8Array([r, g, b, a]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    return { texture, width: 1, height: 1 };
  }

  /**
   * Remove a texture from the cache and destroy it.
   */
  evict(url: string): void {
    const entry = this.cache.get(url);
    if (entry) {
      entry.texture.destroy();
      this.cache.delete(url);
    }
    const videoEntry = this.videoCache.get(url);
    if (videoEntry) {
      // Abort debug event listeners before clearing
      const debugAC = (videoEntry.video as DebugVideoElement).__debugAC;
      if (debugAC) {
        debugAC.abort();
      }
      videoEntry.video.pause();
      videoEntry.video.removeAttribute('src');
      videoEntry.video.load();
      // The element is kept attached to the DOM during its lifetime (Firefox
      // anti-stall — see _doLoadVideo), so remove it here on eviction.
      if (videoEntry.video.parentNode) {
        videoEntry.video.parentNode.removeChild(videoEntry.video);
      }
      videoEntry.texture.destroy();
      this.videoCache.delete(url);
    }
  }

  /**
   * Destroy all cached textures.
   */
  destroy(): void {
    for (const entry of this.cache.values()) {
      entry.texture.destroy();
    }
    this.cache.clear();

    for (const entry of this.videoCache.values()) {
      // Abort debug event listeners
      const debugAC = (entry.video as DebugVideoElement).__debugAC;
      if (debugAC) {
        debugAC.abort();
      }
      entry.video.pause();
      entry.video.removeAttribute('src');
      entry.video.load();
      if (entry.video.parentNode) {
        entry.video.parentNode.removeChild(entry.video);
      }
      entry.texture.destroy();
    }
    this.videoCache.clear();
    this._videoLoadInFlight.clear();
  }
}
