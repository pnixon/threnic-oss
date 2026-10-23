'use client';

/**
 * GLSLSourceEditor — inspector body for a shaderFx instance in `mode: 'glsl'`
 * (Stage 3a). A dedicated editor (not schema-driven) because the GLSL source is
 * multiline code with a LIVE preview, which the generic field editor can't render.
 *
 * It edits the instance's `glsl` sub-config: the GLSL `mainImage` body, layer
 * opacity (with an audio-reactive widget), blend mode, and the four input channels
 * iChannel0..3 (none / audio / 2D image / cubemap, each with wrap/filter/vflip and
 * an audio-reactive intensity). The preview drives a THROWAWAY GLSLGuestRenderer (the
 * exact production render path) fed live audio from audioStore, blitting its canvas
 * into the visible preview each frame — so the preview matches the real guest. The
 * throwaway renderer is force-lost on unmount so it doesn't eat the browser's
 * WebGL2-context budget alongside the real guests.
 *
 * Customer-provided channel images/cubemaps stay LOCAL — stored as blobs in
 * IndexedDB (keyed by the guest instance id), never uploaded.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GLSLGuestRenderer } from '@/engine/gpu/glsl/GLSLGuestRenderer';
import { guestAudioFromStore } from '@/engine/gpu/glsl/audioTexture';
import type {
  GuestBlendMode,
  GuestChannel,
  GuestChannelKind,
  GuestBufferId,
} from '@/engine/gpu/glsl/types';
import { DEFAULT_GUEST_CHANNEL, GUEST_CHANNEL_COUNT } from '@/engine/gpu/glsl/types';
import type { GLSLGuestConfig } from '@/types/effects/effect-instances';
import type { AudioReactiveConfig } from '@/types/effects/audio-reactive';
import { AudioReactiveEditor } from '@/components/effects/shared/AudioReactiveEditor';
import { useEffectEditor } from '@/components/effects/shared/EffectEditorContext';
import {
  saveGuestAsset,
  removeGuestAsset,
  image2dSlot,
  cubemapFaceSlot,
  videoSlot,
  loadGuestImage2D,
  loadGuestCubemap,
  CUBEMAP_FACE_LABELS,
  CUBEMAP_FACE_COUNT,
} from '@/engine/gpu/glsl/glslGuestAssets';
import { GLSL_PRESETS, GLSL_CUSTOM_ID, matchGlslPresetId } from '@/engine/gpu/glsl/glslPresets';
import styles from './GLSLSourceEditor.module.css';

interface Props {
  config: GLSLGuestConfig;
  onChange: (glsl: GLSLGuestConfig) => void;
  /** The shaderFx instance id — used as the IndexedDB asset key namespace. */
  guestId: string;
}

const PREVIEW_W = 480;
const PREVIEW_H = 270;
const PREVIEW_ID = '__preview__';
const CHANNEL_KINDS: { value: GuestChannelKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'audio', label: 'Audio' },
  { value: 'image2d', label: 'Image' },
  { value: 'cubemap', label: 'Cubemap' },
  { value: 'buffer', label: 'Buffer' },
  { value: 'video', label: 'Video' },
];
const BUFFER_IDS = ['a', 'b', 'c', 'd'] as const;

/**
 * IndexedDB slot channel index for an asset (image2d/cubemap/video) on a given
 * pass. Image-pass channels use the plain index 0..3; buffer-pass channels use
 * an offset `100 + bufferIdx*4 + channel` so their keys never collide with the
 * Image pass's. MUST match the offset the GPUCanvas / DecoupledExporter asset
 * loaders use, or a seeded/uploaded asset lands where nothing reads it.
 */
function assetSlotChannel(pass: 'image' | GuestBufferId, channel: number): number {
  if (pass === 'image') return channel;
  const bufIdx = BUFFER_IDS.indexOf(pass);
  return 100 + (bufIdx * GUEST_CHANNEL_COUNT + channel);
}

const DEFAULT_BUFFER_SOURCE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  // Feedback example: sample this buffer (bind iChannel0 = Buffer to self) and decay.
  vec4 prev = texture(iChannel0, uv);
  vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
  fragColor = vec4(mix(col, prev.rgb, 0.9), 1.0);
}`;
const BLEND_MODES: { value: GuestBlendMode; label: string }[] = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'additive', label: 'Add' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'replace', label: 'Replace' },
];

/** Normalize a config to always have exactly GUEST_CHANNEL_COUNT channels. */
function normalizeChannels(config: GLSLGuestConfig): GuestChannel[] {
  const out: GuestChannel[] = [];
  for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
    out.push(config.channels?.[i] ?? { ...DEFAULT_GUEST_CHANNEL, kind: 'none' });
  }
  return out;
}

export function GLSLSourceEditor({ config, onChange, guestId }: Props) {
  // Instance-scoped keyframe prefix (fx.<id>) from the effect-editor context, so
  // the guest's AR settings keyframe over the timeline like other effects.
  const editorCtx = useEffectEditor();
  const fxPrefix = editorCtx?.propertyPrefix ?? `fx.${guestId}`;
  // Local source buffer so typing is snappy; compile is debounced.
  const [activePass, setActivePass] = useState<'image' | GuestBufferId>('image');
  const activeSource =
    activePass === 'image' ? config.source : (config.buffers?.[activePass]?.source ?? '');
  const [sourceDraft, setSourceDraft] = useState(activeSource);
  const [compileLog, setCompileLog] = useState<{ ok: boolean; log: string }>({ ok: true, log: '' });

  const channels = normalizeChannels(config);
  const channelKindsKey = channels.map((c) => c.kind).join(',');
  // Asset key for the CURRENTLY-EDITED pass (Image or a buffer) — drives the
  // preview loader so switching passes / editing buffer-pass assets re-loads.
  const activePassAssetKey = (() => {
    const chs = activePass === 'image' ? channels : (config.buffers?.[activePass]?.channels ?? []);
    return `${activePass}#${chs
      .map((c) => `${c.kind}/${c.assetId ?? ''}/${c.vflip ? 'f' : ''}/${c.wrap}/${c.filter}`)
      .join('|')}`;
  })();
  // Buffer descriptor for the preview renderer (source + channel kinds per enabled buffer).
  const previewBuffers = React.useMemo(() => {
    const out: Partial<
      Record<GuestBufferId, { source: string; channelKinds: GuestChannelKind[] }>
    > = {};
    for (const bid of BUFFER_IDS) {
      const bp = config.buffers?.[bid];
      if (bp)
        out[bid] = { source: bp.source, channelKinds: (bp.channels ?? []).map((c) => c.kind) };
    }
    return out;
  }, [config.buffers]);
  const buffersKindsKey = BUFFER_IDS.map(
    (b) =>
      `${b}:${config.buffers?.[b]?.source.length ?? 0}:${previewBuffers[b]?.channelKinds.join(',') ?? ''}`,
  ).join('|');

  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GLSLGuestRenderer | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  // Keep the draft in sync with the ACTIVE pass's source (pass switch or
  // external keyframe nav).
  useEffect(() => {
    setSourceDraft(activeSource);
  }, [activePass, activeSource]);

  // ── Live preview: throwaway GLSLGuestRenderer driving the visible canvas ──
  useEffect(() => {
    const renderer = new GLSLGuestRenderer(PREVIEW_W, PREVIEW_H);
    rendererRef.current = renderer;
    const ok = renderer.init();
    if (!ok) {
      setCompileLog({ ok: false, log: 'WebGL2 unavailable — preview disabled.' });
      return;
    }
    const first = renderer.setGuest(
      PREVIEW_ID,
      config.source,
      normalizeChannels(config).map((c) => c.kind),
      previewBuffers,
    );
    setCompileLog(first);

    const loop = (t: number) => {
      const r = rendererRef.current;
      const vis = visibleCanvasRef.current;
      if (!r || !r.ready || !vis) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      const dt = lastFrameRef.current ? (t - lastFrameRef.current) / 1000 : 1 / 60;
      lastFrameRef.current = t;
      const audio = guestAudioFromStore();
      r.uploadAudio(audio.fft, audio.wave);
      r.render(PREVIEW_ID, dt, null);
      const src = r.getCanvas();
      if (src) {
        const ctx = vis.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, vis.width, vis.height);
          try {
            ctx.drawImage(src, 0, 0, vis.width, vis.height);
          } catch {
            // Source canvas not yet drawable this frame — skip.
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      // Force-lose the context so the preview doesn't hold a WebGL2 slot.
      renderer.destroy();
      rendererRef.current = null;
      lastFrameRef.current = 0;
    };
    // Only (re)create the renderer on mount; source changes recompile in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced recompile of the preview when the draft, channel kinds, or buffer
  // set/sources change. The source draft edits the ACTIVE pass (Image or a buffer).
  useEffect(() => {
    const h = setTimeout(() => {
      const r = rendererRef.current;
      if (!r || !r.ready) return;
      const result = r.setGuest(
        PREVIEW_ID,
        activePass === 'image' ? sourceDraft : config.source,
        normalizeChannels(config).map((c) => c.kind),
        activePass === 'image'
          ? previewBuffers
          : {
              ...previewBuffers,
              [activePass]: {
                source: sourceDraft,
                channelKinds: (config.buffers?.[activePass]?.channels ?? []).map((c) => c.kind),
              },
            },
      );
      setCompileLog(result);
      // Push buffer-channel bufferId bindings so buffer→buffer sampling resolves.
      for (const bid of BUFFER_IDS) {
        const bp = config.buffers?.[bid];
        if (!bp) continue;
        (bp.channels ?? []).forEach((c, i) => {
          r.setChannelParams(
            PREVIEW_ID,
            i,
            {
              wrap: c.wrap,
              filter: c.filter,
              intensity: c.intensity,
              bufferId: c.kind === 'buffer' ? (c.bufferId ?? null) : null,
            },
            bid,
          );
        });
      }
      // Persist the active pass's source only when it compiles.
      if (result.ok) {
        if (activePass === 'image' && sourceDraft !== config.source) {
          onChange({ ...config, source: sourceDraft });
        } else if (activePass !== 'image' && sourceDraft !== config.buffers?.[activePass]?.source) {
          setBufferSource(activePass, sourceDraft);
        }
      }
    }, 400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDraft, channelKindsKey, buffersKindsKey, activePass]);

  // Load + upload the preview's channel textures from IndexedDB whenever a
  // channel's asset binding / flip / wrap / filter changes.
  useEffect(() => {
    let cancelled = false;
    const r = rendererRef.current;
    if (!r) return;
    (async () => {
      for (let i = 0; i < activeChannels.length; i++) {
        const c = activeChannels[i];
        const slotCh = assetSlotChannel(activePass, i);
        r.setChannelParams(PREVIEW_ID, i, {
          wrap: c.wrap,
          filter: c.filter,
          intensity: c.intensity,
        });
        if (c.kind === 'image2d') {
          const bmp = await loadGuestImage2D(guestId, slotCh, c.vflip);
          if (cancelled) return;
          if (bmp) r.setChannelImage2D(PREVIEW_ID, i, bmp);
          else r.clearChannel(PREVIEW_ID, i);
        } else if (c.kind === 'cubemap') {
          const faces = await loadGuestCubemap(guestId, slotCh, c.vflip);
          if (cancelled) return;
          r.setChannelCubemap(PREVIEW_ID, i, faces);
        } else if (c.kind === 'video') {
          if ((c.videoSource ?? 'background') === 'upload') {
            const { loadGuestAssetUrl, videoSlot } =
              await import('@/engine/gpu/glsl/glslGuestAssets');
            const url = await loadGuestAssetUrl(guestId, videoSlot(slotCh));
            if (cancelled) return;
            r.setChannelVideo(PREVIEW_ID, i, 'upload', url ?? null);
          } else {
            // Preview has no background video element; bind as background (shows
            // a placeholder until the main scene provides one).
            r.setChannelVideo(PREVIEW_ID, i, 'background', null);
          }
        } else if (c.kind !== 'buffer') {
          r.clearChannel(PREVIEW_ID, i);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePassAssetKey, guestId]);

  const setOpacity = useCallback(
    (v: number) => onChange({ ...config, opacity: Math.max(0, Math.min(1, v)) }),
    [config, onChange],
  );
  const setBlend = useCallback(
    (m: GuestBlendMode) => onChange({ ...config, blendMode: m }),
    [config, onChange],
  );

  // Opacity audio-reactive config (reuses the shared AR widget).
  const setOpacityReactive = useCallback(
    (ar: AudioReactiveConfig) =>
      onChange({ ...config, audioReactive: { ...config.audioReactive, opacity: ar } }),
    [config, onChange],
  );

  // Replace one channel's config (index-aligned; normalizes to 4 first).
  const updateChannel = useCallback(
    (idx: number, patch: Partial<GuestChannel>) => {
      const next = normalizeChannels(config);
      next[idx] = { ...next[idx], ...patch };
      onChange({ ...config, channels: next });
    },
    [config, onChange],
  );

  // Upload a 2D image for a channel → IndexedDB (local only), then bind it.
  // Pass-aware: image-pass uses key `idx`, buffer-pass uses the offset key so it
  // matches the loader. `bindChannel` writes to the correct pass's config.
  // Forward ref to updateBufferChannel (defined below) so bindChannel — which
  // several upload handlers depend on and which must be declared before it — can
  // dispatch buffer-pass channel writes without a TDZ on the const.
  const updateBufferChannelRef = useRef<
    (bid: GuestBufferId, idx: number, patch: Partial<GuestChannel>) => void
  >(() => {});

  const bindChannel = useCallback(
    (idx: number, patch: Partial<GuestChannel>) => {
      if (activePass === 'image') updateChannel(idx, patch);
      else updateBufferChannelRef.current(activePass, idx, patch);
    },
    [activePass, updateChannel],
  );

  const uploadImage2D = useCallback(
    async (idx: number, file: File) => {
      const slotCh = assetSlotChannel(activePass, idx);
      await saveGuestAsset(guestId, image2dSlot(slotCh), file);
      bindChannel(idx, { kind: 'image2d', assetId: image2dSlot(slotCh) });
    },
    [guestId, bindChannel, activePass],
  );

  // Upload one cubemap face → IndexedDB. The channel becomes 'cubemap'; faces
  // fill in independently (missing faces render black until supplied).
  const uploadCubemapFace = useCallback(
    async (idx: number, face: number, file: File) => {
      const slotCh = assetSlotChannel(activePass, idx);
      await saveGuestAsset(guestId, cubemapFaceSlot(slotCh, face), file);
      bindChannel(idx, { kind: 'cubemap', assetId: `cube` });
    },
    [guestId, bindChannel, activePass],
  );

  const clearChannelAsset = useCallback(
    async (idx: number) => {
      const slotCh = assetSlotChannel(activePass, idx);
      await removeGuestAsset(guestId, image2dSlot(slotCh));
      for (let f = 0; f < CUBEMAP_FACE_COUNT; f++) {
        await removeGuestAsset(guestId, cubemapFaceSlot(slotCh, f));
      }
      await removeGuestAsset(guestId, videoSlot(slotCh));
      bindChannel(idx, { kind: 'none', assetId: undefined });
    },
    [guestId, bindChannel, activePass],
  );

  // Upload a video file for a channel → IndexedDB (local only); bind as 'upload'.
  const uploadVideo = useCallback(
    async (idx: number, file: File) => {
      const slotCh = assetSlotChannel(activePass, idx);
      await saveGuestAsset(guestId, videoSlot(slotCh), file);
      bindChannel(idx, { kind: 'video', videoSource: 'upload', assetId: videoSlot(slotCh) });
    },
    [guestId, bindChannel, activePass],
  );

  // ── Multipass: buffer editing (activePass declared above) ──
  const toggleBuffer = useCallback(
    (bid: GuestBufferId) => {
      const buffers = { ...(config.buffers ?? {}) };
      if (buffers[bid]) {
        delete buffers[bid];
        setActivePass((p) => (p === bid ? 'image' : p));
      } else {
        buffers[bid] = {
          source: DEFAULT_BUFFER_SOURCE,
          channels: Array.from({ length: GUEST_CHANNEL_COUNT }, (_, i) => ({
            ...DEFAULT_GUEST_CHANNEL,
            // Default iChannel0 of a fresh buffer to sample ITSELF (feedback).
            kind: i === 0 ? ('buffer' as const) : ('none' as const),
            bufferId: i === 0 ? bid : undefined,
          })),
        };
        setActivePass(bid);
      }
      onChange({ ...config, buffers });
    },
    [config, onChange],
  );

  const setBufferSource = useCallback(
    (bid: GuestBufferId, source: string) => {
      const buffers = { ...(config.buffers ?? {}) };
      const bp = buffers[bid];
      if (!bp) return;
      buffers[bid] = { ...bp, source };
      onChange({ ...config, buffers });
    },
    [config, onChange],
  );

  const updateBufferChannel = useCallback(
    (bid: GuestBufferId, idx: number, patch: Partial<GuestChannel>) => {
      const buffers = { ...(config.buffers ?? {}) };
      const bp = buffers[bid];
      if (!bp) return;
      const chans = (bp.channels ?? []).slice();
      while (chans.length < GUEST_CHANNEL_COUNT) chans.push({ ...DEFAULT_GUEST_CHANNEL });
      chans[idx] = { ...chans[idx], ...patch };
      buffers[bid] = { ...bp, channels: chans };
      onChange({ ...config, buffers });
    },
    [config, onChange],
  );
  updateBufferChannelRef.current = updateBufferChannel;

  // ── Active-pass channel accessors: one channel strip serves Image or a buffer.
  const activeChannels: GuestChannel[] =
    activePass === 'image'
      ? channels
      : (() => {
          const bp = config.buffers?.[activePass];
          const out: GuestChannel[] = [];
          for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
            out.push(bp?.channels?.[i] ?? { ...DEFAULT_GUEST_CHANNEL });
          }
          return out;
        })();
  const setChannelKind = (i: number, kind: GuestChannelKind) => {
    const extra: Partial<GuestChannel> =
      kind === 'video'
        ? { videoSource: 'background' }
        : kind === 'none'
          ? { assetId: undefined }
          : {};
    if (kind === 'none') void clearChannelAsset(i);
    else bindChannel(i, { kind, ...extra });
  };
  const patchChannel = (i: number, patch: Partial<GuestChannel>) => {
    if (activePass === 'image') updateChannel(i, patch);
    else updateBufferChannel(activePass, i, patch);
  };

  return (
    <div className={styles.editor}>
      <div className={styles.previewWrap}>
        <canvas
          ref={visibleCanvasRef}
          width={PREVIEW_W}
          height={PREVIEW_H}
          className={styles.previewCanvas}
        />
        <span className={styles.previewBadge}>Live preview</span>
      </div>

      {/* Pass selector: Image + Buffer A–D (multipass). Click a buffer letter to
          enable/select it; the ✕ disables it. Source + channels below edit the
          selected pass. */}
      <div className={styles.passTabs} role="group" aria-label="GLSL pass selector">
        <button
          type="button"
          className={`${styles.passTab} ${activePass === 'image' ? styles.passTabActive : ''}`}
          aria-pressed={activePass === 'image'}
          onClick={() => setActivePass('image')}
        >
          Image
        </button>
        {BUFFER_IDS.map((bid) => {
          const enabled = !!config.buffers?.[bid];
          return (
            <div key={bid} className={styles.passTabBuf}>
              <button
                type="button"
                className={`${styles.passTab} ${activePass === bid ? styles.passTabActive : ''} ${enabled ? '' : styles.passTabOff}`}
                aria-pressed={activePass === bid}
                onClick={() => (enabled ? setActivePass(bid) : toggleBuffer(bid))}
                title={
                  enabled
                    ? `Edit Buffer ${bid.toUpperCase()}`
                    : `Enable Buffer ${bid.toUpperCase()}`
                }
              >
                Buf {bid.toUpperCase()}
              </button>
              {enabled && (
                <button
                  type="button"
                  className={styles.passTabClose}
                  aria-label={`Disable Buffer ${bid.toUpperCase()}`}
                  onClick={() => toggleBuffer(bid)}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.sourceLabel}>
        <span>
          {activePass === 'image' ? 'Image' : `Buffer ${activePass.toUpperCase()}`} · mainImage(out
          vec4, in vec2)
        </span>
        {compileLog.ok ? (
          <span className={styles.okLog}>✓ compiled</span>
        ) : (
          <span style={{ color: '#ff8b8f' }}>✗ error</span>
        )}
      </div>
      {/* Preset picker (Image pass only) — the "pick a script, or write your
          own" dropdown, like the Butterchurn/Milkdrop pickers but for the GLSL
          generative guest. Selecting a preset replaces the Image source;
          "Custom…" leaves whatever the user has authored. Multipass buffers
          keep their own hand-written bodies, so the picker is hidden there. */}
      {activePass === 'image' && (
        <div className={styles.row} style={{ marginBottom: 6 }}>
          <label className={styles.rowLabel}>Preset</label>
          <select
            style={{
              flex: 1,
              fontSize: 11,
              borderRadius: 6,
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              padding: '4px 8px',
            }}
            value={matchGlslPresetId(config.source)}
            onChange={(e) => {
              const id = e.target.value;
              if (id === GLSL_CUSTOM_ID) return; // keep current source
              const preset = GLSL_PRESETS.find((p) => p.id === id);
              if (!preset) return;
              setSourceDraft(preset.source);
              // Apply the preset's declared channel kinds so a preset that needs
              // audio (or any channel) binds it on pick — channels otherwise
              // default to 'none' (unbound). Preserve per-channel wrap/filter/
              // assetId; only the kind (and bufferId for a 'buffer' kind) is set
              // from the preset.
              const next: GLSLGuestConfig = { ...config, source: preset.source };
              // Apply the preset's audio routing table so uValue1..8 wire to
              // audio sources on pick (else every slot resolves to 0).
              if (preset.audioRouting) next.audioRouting = preset.audioRouting;
              if (preset.channelKinds) {
                const base = normalizeChannels(config);
                next.channels = base.map((c, i) => {
                  const kind = preset.channelKinds![i] ?? 'none';
                  return {
                    ...c,
                    kind,
                    bufferId: kind === 'buffer' ? (preset.bufferRefs?.[i] ?? 'a') : c.bufferId,
                    // Image-pass embedded cubemap gets its assetId set so the
                    // renderer loads the seeded faces below.
                    assetId:
                      preset.embeddedCubemap?.channel === i && kind === 'cubemap'
                        ? 'cube'
                        : kind === 'none'
                          ? undefined
                          : c.assetId,
                  };
                });
              }
              // Seed a top-level (Image-pass) embedded cubemap into IndexedDB at
              // the plain channel key (Image pass uses no offset).
              if (preset.embeddedCubemap) {
                const seed = preset.embeddedCubemap;
                void (async () => {
                  for (let f = 0; f < seed.faces.length; f++) {
                    try {
                      const res = await fetch(seed.faces[f]);
                      const blob = await res.blob();
                      await saveGuestAsset(guestId, cubemapFaceSlot(seed.channel, f), blob);
                    } catch {
                      // best-effort
                    }
                  }
                })();
              }
              // Seed multipass buffers the preset ships (Buffer A–D). Only the
              // ids present are enabled; each buffer's channels are materialized
              // from its declared kinds (+ bufferRefs for 'buffer' kinds).
              if (preset.buffers) {
                const seeded: NonNullable<GLSLGuestConfig['buffers']> = {};
                const embeddedSeeds: {
                  channel: number;
                  faces: string[];
                  bufferId: GuestBufferId;
                }[] = [];
                const imageSeeds: {
                  channel: number;
                  dataUri: string;
                  bufferId: GuestBufferId;
                }[] = [];
                for (const bid of BUFFER_IDS) {
                  const bp = preset.buffers[bid];
                  if (!bp) continue;
                  const chans: GuestChannel[] = [];
                  for (let i = 0; i < GUEST_CHANNEL_COUNT; i++) {
                    const kind = bp.channelKinds[i] ?? 'none';
                    const isImg = bp.embeddedImage?.channel === i && kind === 'image2d';
                    chans.push({
                      ...DEFAULT_GUEST_CHANNEL,
                      kind,
                      // A 'buffer' kind with no ref self-references this pass.
                      bufferId: kind === 'buffer' ? (bp.bufferRefs?.[i] ?? bid) : undefined,
                      // A cubemap/image channel the preset ships gets its assetId
                      // set so the renderer loads the asset we seed into IndexedDB.
                      assetId:
                        bp.embeddedCubemap?.channel === i ? 'cube' : isImg ? 'img' : undefined,
                    });
                  }
                  if (bp.embeddedCubemap)
                    embeddedSeeds.push({ ...bp.embeddedCubemap, bufferId: bid });
                  if (bp.embeddedImage) imageSeeds.push({ ...bp.embeddedImage, bufferId: bid });
                  seeded[bid] = { source: bp.source, channels: chans };
                }
                next.buffers = seeded;
                // Fire-and-forget: write the preset's embedded assets into this
                // guest's local IndexedDB slots so buffer passes render without a
                // manual upload. A BUFFER-pass channel keys its assets at an offset
                // (100 + bufIdx*4 + channel) to stay distinct from Image-pass keys
                // — the GPUCanvas loader uses that exact offset, so seeds must match.
                for (const seed of embeddedSeeds) {
                  const bufIdx = BUFFER_IDS.indexOf(seed.bufferId);
                  const slotChannel =
                    bufIdx >= 0
                      ? 100 + (bufIdx * GUEST_CHANNEL_COUNT + seed.channel)
                      : seed.channel;
                  void (async () => {
                    for (let f = 0; f < seed.faces.length; f++) {
                      try {
                        const res = await fetch(seed.faces[f]);
                        const blob = await res.blob();
                        await saveGuestAsset(guestId, cubemapFaceSlot(slotChannel, f), blob);
                      } catch {
                        // best-effort: a missing face just renders black.
                      }
                    }
                  })();
                }
                for (const seed of imageSeeds) {
                  const bufIdx = BUFFER_IDS.indexOf(seed.bufferId);
                  const slotChannel =
                    bufIdx >= 0
                      ? 100 + (bufIdx * GUEST_CHANNEL_COUNT + seed.channel)
                      : seed.channel;
                  void (async () => {
                    try {
                      const res = await fetch(seed.dataUri);
                      const blob = await res.blob();
                      await saveGuestAsset(guestId, image2dSlot(slotChannel), blob);
                    } catch {
                      // best-effort: a missing image just renders black.
                    }
                  })();
                }
              }
              onChange(next);
            }}
            aria-label="GLSL preset"
          >
            {GLSL_PRESETS.map((p) => (
              <option key={p.id} value={p.id} title={p.description}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <textarea
        className={`${styles.source} ${compileLog.ok ? '' : styles.hasError}`}
        spellCheck={false}
        value={sourceDraft}
        onChange={(e) => setSourceDraft(e.target.value)}
        aria-label="GLSL fragment source"
      />
      {!compileLog.ok && compileLog.log && <div className={styles.errorLog}>{compileLog.log}</div>}

      <div className={styles.row}>
        <span className={styles.rowLabel}>Opacity</span>
        <input
          className={styles.slider}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={config.opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          aria-label="GLSL guest opacity"
        />
        <span className={styles.rowLabel} style={{ minWidth: 32, textAlign: 'right' }}>
          {config.opacity.toFixed(2)}
        </span>
      </div>

      {/* Audio-reactive opacity (shared AR widget, keyframeable over the timeline). */}
      <AudioReactiveEditor
        label="Opacity reactivity"
        config={config.audioReactive?.opacity}
        onChange={setOpacityReactive}
        min={0}
        max={1}
        step={0.01}
        propertyPrefix={`${fxPrefix}.glsl.audioReactive.opacity`}
      />

      {activePass === 'image' && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>Blend</span>
          <div className={styles.blendGroup} role="group" aria-label="GLSL guest blend mode">
            {BLEND_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`${styles.blendBtn} ${config.blendMode === m.value ? styles.blendBtnActive : ''}`}
                aria-pressed={config.blendMode === m.value}
                onClick={() => setBlend(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* iChannel0..3 bindings for the ACTIVE pass (Image or Buffer A–D). */}
      <div className={styles.channelsSection}>
        <div className={styles.sourceLabel}>
          <span>
            {activePass === 'image' ? 'Image' : `Buffer ${activePass.toUpperCase()}`} channels ·
            iChannel0–3
          </span>
        </div>
        {activeChannels.map((ch, i) => {
          const kinds = CHANNEL_KINDS;
          return (
            <div key={i} className={styles.channelCard}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>iChannel{i}</span>
                <div className={styles.blendGroup} role="group" aria-label={`iChannel${i} kind`}>
                  {kinds.map((k) => (
                    <button
                      key={k.value}
                      type="button"
                      className={`${styles.blendBtn} ${ch.kind === k.value ? styles.blendBtnActive : ''}`}
                      aria-pressed={ch.kind === k.value}
                      onClick={() => setChannelKind(i, k.value)}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              </div>

              {ch.kind === 'buffer' && (
                <div className={styles.row}>
                  <span className={styles.rowLabel}>Source buffer</span>
                  <div
                    className={styles.blendGroup}
                    role="group"
                    aria-label={`iChannel${i} source buffer`}
                  >
                    {BUFFER_IDS.map((b) => {
                      const enabled = !!config.buffers?.[b];
                      return (
                        <button
                          key={b}
                          type="button"
                          disabled={!enabled}
                          className={`${styles.blendBtn} ${ch.bufferId === b ? styles.blendBtnActive : ''}`}
                          aria-pressed={ch.bufferId === b}
                          onClick={() => patchChannel(i, { bufferId: b })}
                          title={
                            enabled
                              ? `Sample Buffer ${b.toUpperCase()}`
                              : `Enable Buffer ${b.toUpperCase()} first`
                          }
                        >
                          {b.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {ch.kind === 'video' && (
                <>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Video src</span>
                    <div
                      className={styles.blendGroup}
                      role="group"
                      aria-label={`iChannel${i} video source`}
                    >
                      {(['background', 'upload'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={`${styles.blendBtn} ${(ch.videoSource ?? 'background') === s ? styles.blendBtnActive : ''}`}
                          aria-pressed={(ch.videoSource ?? 'background') === s}
                          onClick={() => patchChannel(i, { videoSource: s })}
                        >
                          {s === 'background' ? 'Background' : 'Upload'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {(ch.videoSource ?? 'background') === 'upload' && (
                    <div className={styles.row}>
                      <span className={styles.rowLabel}>Video</span>
                      <input
                        type="file"
                        accept="video/*"
                        aria-label={`iChannel${i} video upload`}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadVideo(i, f);
                        }}
                      />
                    </div>
                  )}
                  <div className={styles.channelHint}>
                    {(ch.videoSource ?? 'background') === 'background'
                      ? "Samples the track's background video."
                      : 'Uploaded video stays local (IndexedDB), never uploaded.'}{' '}
                    Export grabs the current frame (not frame-accurate).
                  </div>
                </>
              )}

              {ch.kind === 'image2d' && (
                <div className={styles.row}>
                  <span className={styles.rowLabel}>Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    aria-label={`iChannel${i} image upload`}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadImage2D(i, f);
                    }}
                  />
                </div>
              )}

              {ch.kind === 'cubemap' && (
                <div
                  className={styles.cubemapGrid}
                  role="group"
                  aria-label={`iChannel${i} cubemap faces`}
                >
                  {CUBEMAP_FACE_LABELS.map((faceLabel, f) => (
                    <label key={f} className={styles.cubemapFace}>
                      <span className={styles.rowLabel}>{faceLabel}</span>
                      <input
                        type="file"
                        accept="image/*"
                        aria-label={`iChannel${i} cubemap face ${faceLabel}`}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void uploadCubemapFace(i, f, file);
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}

              {(ch.kind === 'image2d' || ch.kind === 'cubemap') && (
                <>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Wrap</span>
                    <div
                      className={styles.blendGroup}
                      role="group"
                      aria-label={`iChannel${i} wrap`}
                    >
                      {(['repeat', 'clamp'] as const).map((w) => (
                        <button
                          key={w}
                          type="button"
                          className={`${styles.blendBtn} ${ch.wrap === w ? styles.blendBtnActive : ''}`}
                          aria-pressed={ch.wrap === w}
                          onClick={() => patchChannel(i, { wrap: w })}
                        >
                          {w}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Filter</span>
                    <div
                      className={styles.blendGroup}
                      role="group"
                      aria-label={`iChannel${i} filter`}
                    >
                      {(['linear', 'nearest', 'mipmap'] as const).map((fl) => (
                        <button
                          key={fl}
                          type="button"
                          className={`${styles.blendBtn} ${ch.filter === fl ? styles.blendBtnActive : ''}`}
                          aria-pressed={ch.filter === fl}
                          onClick={() => patchChannel(i, { filter: fl })}
                        >
                          {fl}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <span className={styles.rowLabel}>Flip V</span>
                    <input
                      type="checkbox"
                      checked={ch.vflip}
                      onChange={(e) => patchChannel(i, { vflip: e.target.checked })}
                      aria-label={`iChannel${i} vertical flip`}
                    />
                  </label>
                </>
              )}

              {ch.kind !== 'none' && (
                <>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Intensity</span>
                    <input
                      className={styles.slider}
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={ch.intensity}
                      onChange={(e) => patchChannel(i, { intensity: Number(e.target.value) })}
                      aria-label={`iChannel${i} intensity`}
                    />
                    <span className={styles.rowLabel} style={{ minWidth: 32, textAlign: 'right' }}>
                      {ch.intensity.toFixed(2)}
                    </span>
                  </div>
                  <AudioReactiveEditor
                    label={`iChannel${i} intensity reactivity`}
                    config={ch.intensityReactive}
                    onChange={(ar) => patchChannel(i, { intensityReactive: ar })}
                    min={0}
                    max={1}
                    step={0.01}
                    propertyPrefix={
                      activePass === 'image'
                        ? `${fxPrefix}.glsl.channels.${i}.intensityReactive`
                        : undefined
                    }
                  />
                  <div className={styles.channelHint}>
                    Multiply <code>iChannelIntensity[{i}]</code> into your sample to use this.
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
