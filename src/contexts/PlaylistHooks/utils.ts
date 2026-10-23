import type { Track } from '@/contexts/types';
import type { LyricTheme } from '@/types/lyrics';
import { DEFAULT_LYRICS_THEME } from '@/types/lyrics';
import { DEFAULT_EFFECTS_CONFIG, type EffectInstance } from '@/types/effects';
import { setNestedValue } from '@/utils/objectUtils';

/**
 * Syncs a property update to the track's base properties (for Default state).
 * Mutates the provided track object (which should be a shallow copy of the original).
 */
export function syncBaseProperty(track: Track, propertyPath: string, value: unknown): void {
  if (propertyPath === 'lyricsTheme') {
    // Whole-object replacement (e.g. the Lyric FX panel writes the entire
    // lyricsTheme with an updated `lyricFX` stack). Without this branch the
    // path matched none of the prefixed cases below and the write was silently
    // dropped, so adding/toggling a Lyric FX effect did nothing.
    track.lyricsTheme = { ...(value as LyricTheme) };
  } else if (propertyPath.startsWith('lyrics.')) {
    const lyricProp = propertyPath.replace('lyrics.', '');
    track.lyricsTheme = track.lyricsTheme
      ? { ...track.lyricsTheme }
      : ({ ...DEFAULT_LYRICS_THEME } as LyricTheme);

    if (lyricProp.startsWith('colors.')) {
      setNestedValue(track.lyricsTheme, lyricProp, value);
      // Keep the FLAT colorPre/colorActive/colorPost fields in lock-step with
      // the nested `colors` object. The GPU Lyric FX driver (and the Canvas2D
      // renderer) read the flat field FIRST (theme.colorPre ?? theme.colors?.pre),
      // so a write that only touched the nested key would be shadowed by the
      // stale flat value and the picker change would never render. Mirror it here
      // — this is the single point where a `lyrics.colors.*` write lands, so both
      // representations can never diverge (base-theme AND keyframe writes).
      const sub = lyricProp.slice('colors.'.length);
      const flatKey =
        sub === 'pre'
          ? 'colorPre'
          : sub === 'active'
            ? 'colorActive'
            : sub === 'post'
              ? 'colorPost'
              : null;
      if (flatKey) {
        track.lyricsTheme[flatKey] = value as string;
      }
    } else {
      (track.lyricsTheme as unknown as Record<string, unknown>)[lyricProp] = value;
    }
  } else if (propertyPath.startsWith('fx.')) {
    // Instance-aware addressing: fx.<instanceId>.<property>
    const parts = propertyPath.split('.');
    const instanceId = parts[1];
    const instanceProp = parts.slice(2).join('.');

    if (instanceId && instanceProp) {
      track.effectsConfig = track.effectsConfig
        ? structuredClone(track.effectsConfig)
        : structuredClone(DEFAULT_EFFECTS_CONFIG);

      if (!track.effectsConfig.effectInstances) {
        track.effectsConfig.effectInstances = [];
      }

      const idx = track.effectsConfig.effectInstances.findIndex((inst) => inst.id === instanceId);
      if (idx !== -1) {
        const instance = { ...track.effectsConfig.effectInstances[idx] };
        instance.config = { ...instance.config };
        setNestedValue(instance.config, instanceProp, value);
        track.effectsConfig.effectInstances[idx] = instance as EffectInstance;
      }
    }
  } else if (propertyPath.startsWith('effects.')) {
    const fxProp = propertyPath.replace('effects.', '');
    track.effectsConfig = track.effectsConfig
      ? structuredClone(track.effectsConfig)
      : structuredClone(DEFAULT_EFFECTS_CONFIG);

    setNestedValue(track.effectsConfig, fxProp, value);
  } else if (propertyPath.startsWith('scene.')) {
    const sceneProp = propertyPath.replace('scene.', '');
    if (sceneProp === 'assetUrl') {
      track.backgroundImage = (value as string) || undefined;
    } else if (sceneProp === 'backgroundColor') {
      track.effectsConfig = track.effectsConfig
        ? structuredClone(track.effectsConfig)
        : structuredClone(DEFAULT_EFFECTS_CONFIG);
      track.effectsConfig.backgroundColor = value as string;
      if (track.effectsConfig.visualizer) {
        track.effectsConfig.visualizer.backgroundColor = value as string;
      }
    } else {
      track.effectsConfig = track.effectsConfig
        ? structuredClone(track.effectsConfig)
        : structuredClone(DEFAULT_EFFECTS_CONFIG);
      (track.effectsConfig as unknown as Record<string, unknown>)[sceneProp] = value;
    }
  }
}

/**
 * Syncs an effect instance update to the track's base configuration.
 * Mutates the provided track object (which should be a shallow copy of the original).
 */
export function syncBaseEffectInstance(
  track: Track,
  instanceId: string,
  instanceConfig: unknown,
): void {
  track.effectsConfig = track.effectsConfig
    ? structuredClone(track.effectsConfig)
    : structuredClone(DEFAULT_EFFECTS_CONFIG);

  if (!track.effectsConfig.effectInstances) {
    track.effectsConfig.effectInstances = [];
  }

  const idx = track.effectsConfig.effectInstances.findIndex((inst) => inst.id === instanceId);
  if (idx !== -1) {
    track.effectsConfig.effectInstances[idx] = {
      ...track.effectsConfig.effectInstances[idx],
      config: instanceConfig,
    } as EffectInstance;
  } else {
    const type = instanceId.replace('instance-', '') as EffectInstance['type'];
    track.effectsConfig.effectInstances.push({
      id: instanceId,
      type,
      config: instanceConfig,
    } as EffectInstance);
  }
}
