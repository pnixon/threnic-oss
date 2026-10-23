import { EffectsConfig, DEFAULT_EFFECTS_CONFIG } from '@/types/effects';
import { EffectInstance, EffectType } from '@/types/effects/effect-instances';
import { seedLayerOrderFromTargets } from '@/types/effects/layer-order';
import type { Keyframe } from '@/types/keyframes';
import { scanKeyframesForEffects } from './keyframes';

/**
 * Custom ID generator for migrations (simple fallback)
 */
function makeMigrationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const SCENE_SINGLETON_TYPES = ['particles', 'rain', 'visualizer', 'starfield'];

/**
 * Migrates legacy effects (enabled in config.particles, config.rain, or config.postProcessing)
 * into the new effectInstances array. Also migrates individual keyframes.
 * This ensures old projects load correctly into the new stack-based UI.
 */
export function migrateLegacyEffects(
  config?: EffectsConfig,
  keyframes?: Keyframe[],
): { config: EffectsConfig; keyframes: Keyframe[] } {
  const currentConfig = config || DEFAULT_EFFECTS_CONFIG;
  let migratedKeyframes = [...(keyframes || [])];

  // Check if this project was already saved with the modern effectInstances format
  const hasExplicitInstances =
    config &&
    'effectInstances' in config &&
    Array.isArray(config.effectInstances) &&
    config.effectInstances.length > 0;

  // 1. Migrate base track config
  const effectInstances: EffectInstance[] = [...(currentConfig.effectInstances || [])];

  // Only perform the base legacy migration if `effectInstances` didn't explicitly exist.
  if (!hasExplicitInstances) {
    // 1a. Migrate Scene Effects
    if (currentConfig.particles?.enabled) {
      effectInstances.push({
        id: `migrated-particles-${makeMigrationId()}`,
        type: 'particles',
        config: { ...currentConfig.particles },
      } as EffectInstance);
    }

    if (currentConfig.rain?.enabled) {
      effectInstances.push({
        id: `migrated-rain-${makeMigrationId()}`,
        type: 'rain',
        config: { ...currentConfig.rain },
      } as EffectInstance);
    }

    if (currentConfig.visualizer?.enabled) {
      effectInstances.push({
        id: `migrated-visualizer-${makeMigrationId()}`,
        type: 'visualizer',
        config: { ...currentConfig.visualizer },
      } as EffectInstance);
    }

    // 1b. Migrate Post-Processing Effects
    const order = currentConfig.effectOrder || [];
    const postProcessing = currentConfig.postProcessing || {};
    const ppKeys = Object.keys(postProcessing);

    const sortedKeys = [...ppKeys].sort((a, b) => {
      const idxA = order.indexOf(a as (typeof order)[number]);
      const idxB = order.indexOf(b as (typeof order)[number]);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

    for (const key of sortedKeys) {
      const ppConfig = postProcessing[key as keyof typeof postProcessing];
      if (ppConfig?.enabled) {
        effectInstances.push({
          id: `migrated-pp-${key}-${makeMigrationId()}`,
          type: key as EffectType,
          config: { ...ppConfig },
        } as EffectInstance);
      }
    }
  }

  // 2. Migrate individual Keyframes
  if (migratedKeyframes.length > 0) {
    migratedKeyframes = migratedKeyframes.map((kf) => {
      const nextProps = { ...kf.properties };
      let hasChanges = false;

      // Group properties by effect type
      const propertyGroups: Record<string, Record<string, unknown>> = {};

      for (const [path, val] of Object.entries(nextProps)) {
        if (path === 'effectInstances') {
          // Flatten existing effectInstances array into property paths
          const instances = val as Array<{ type?: string; config?: Record<string, unknown> }>;
          if (Array.isArray(instances)) {
            for (const inst of instances) {
              if (inst.type && inst.config) {
                if (!propertyGroups[inst.type]) propertyGroups[inst.type] = {};
                Object.assign(propertyGroups[inst.type], inst.config);
              }
            }
          }
          delete nextProps[path];
          hasChanges = true;
          continue;
        }

        const parts = path.split('.');
        let type: string | null = null;
        let subPath: string | null = null;

        // Skip current format properties - they are already correct
        if (
          parts[0] === 'effects' ||
          parts[0] === 'scene' ||
          parts[0] === 'lyrics' ||
          parts[0] === 'fx'
        ) {
          continue;
        }

        // Path: bloom.enabled (very old format without prefix)
        if (parts.length >= 2) {
          if (SCENE_SINGLETON_TYPES.includes(parts[0])) {
            type = parts[0];
            subPath = parts.slice(1).join('.');
          } else {
            // Post-processing effect without prefix
            type = parts[0];
            subPath = parts.slice(1).join('.');
          }
        } else if (parts.length === 1) {
          // Might be a top-level enabled flag like 'bloom'
          type = parts[0];
          subPath = 'enabled';
        }

        if (type) {
          if (!propertyGroups[type]) propertyGroups[type] = {};
          propertyGroups[type][subPath || 'enabled'] = val;
          delete nextProps[path];
          hasChanges = true;
        }
      }

      // Map grouped properties to the new flat property path format
      if (hasChanges) {
        for (const [type, props] of Object.entries(propertyGroups)) {
          const isPP = !SCENE_SINGLETON_TYPES.includes(type);
          const prefix = isPP ? `effects.postProcessing.${type}` : `effects.${type}`;

          for (const [prop, val] of Object.entries(props)) {
            nextProps[`${prefix}.${prop}`] = val;
          }
        }
      }

      let lane: 'background' | 'effects' | 'lyrics' | undefined = kf.lane;
      if (!lane) {
        const keys = Object.keys(nextProps);
        if (keys.some((k) => k.startsWith('lyrics.'))) {
          lane = 'lyrics';
        } else if (keys.some((k) => k.startsWith('effects.'))) {
          lane = 'effects';
        } else if (keys.some((k) => k.startsWith('scene.')) || keys.includes('transition')) {
          lane = 'background';
        } else {
          lane = 'effects';
        }
      }

      return {
        ...kf,
        properties: nextProps,
        lane,
      };
    });
  }

  // 1a (re-scan). Scan keyframes AGAIN after migration to find all referenced effects
  const finalReferencedEffects = scanKeyframesForEffects(migratedKeyframes);

  // 3. Ensure all effects referenced in keyframes have instances (even if disabled)
  // This allows the UI to show and edit these effects
  for (const effectType of finalReferencedEffects) {
    const hasInstance = effectInstances.some((inst) => inst.type === effectType);

    if (!hasInstance) {
      // Get default config for this effect type
      let defaultConfig: Record<string, unknown> = { enabled: false };

      if (SCENE_SINGLETON_TYPES.includes(effectType)) {
        defaultConfig = {
          ...(currentConfig as unknown as Record<string, object | undefined>)[effectType],
          enabled: false,
        };
      } else {
        defaultConfig = {
          ...(
            currentConfig.postProcessing as unknown as
              | Record<string, object | undefined>
              | undefined
          )?.[effectType],
          enabled: false,
        };
      }

      effectInstances.push({
        id: `keyframe-ref-${effectType}-${makeMigrationId()}`,
        type: effectType as EffectType,
        config: defaultConfig,
      } as EffectInstance);
    }
  }

  // NOTE: We no longer auto-create an initial t=0 keyframe here.
  // The interpolation system handles "before first keyframe" correctly by
  // returning base config defaults. Auto-creating a t=0 keyframe was causing
  // effects added at later keyframes (e.g., 6s) to retroactively appear at t=0.

  // 4. Reverse layer migration (drag-as-source-of-truth): the render split is
  // now position-driven off the draggable Lyrics token, not the per-instance
  // `target` field. For a project saved under the old target-driven model,
  // materialize a concrete `layerOrder` from its `target` values so effects
  // that used to warp the lyrics keep doing so. No-op (returns undefined) when
  // the project already has a dragged order, or nothing targeted the lyrics.
  const seededOrder = seedLayerOrderFromTargets(effectInstances, currentConfig.layerOrder);

  return {
    config: {
      ...currentConfig,
      effectInstances,
      ...(seededOrder ? { layerOrder: seededOrder } : {}),
    },
    keyframes: migratedKeyframes,
  };
}
