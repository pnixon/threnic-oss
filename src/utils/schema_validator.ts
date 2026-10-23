/**
 * schema_validator.ts — Runtime JSON schema validation for Threnic project files.
 *
 * Performs structural validation of project files without external dependencies.
 * Validates required fields, types, value ranges, and relationships.
 *
 * Usage:
 *   const result = validateProject(jsonData);
 *   if (!result.valid) {
 *     console.error(result.errors);
 *   }
 */

import type { ProjectValidationResult } from '@/types/project';
import { PROJECT_VERSION } from '@/types/project';

// ─── Validation Primitives ──────────────────────────────────

type Validator = (value: unknown, path: string) => string[];

function isString(value: unknown, path: string): string[] {
  if (typeof value !== 'string') return [`${path}: expected string, got ${typeof value}`];
  return [];
}

function isNumber(value: unknown, path: string): string[] {
  if (typeof value !== 'number' || isNaN(value as number))
    return [`${path}: expected number, got ${typeof value}`];
  return [];
}

function isBoolean(value: unknown, path: string): string[] {
  if (typeof value !== 'boolean') return [`${path}: expected boolean, got ${typeof value}`];
  return [];
}

function isObject(value: unknown, path: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return [`${path}: expected object`];
  return [];
}

function isArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path}: expected array, got ${typeof value}`];
  return [];
}

function isOptional(validator: Validator): Validator {
  return (value, path) => {
    if (value === undefined || value === null) return [];
    return validator(value, path);
  };
}

function isOneOf<T extends string>(allowed: readonly T[]): Validator {
  return (value, path) => {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
      return [`${path}: expected one of [${allowed.join(', ')}], got "${value}"`];
    return [];
  };
}

function isNumberInRange(min: number, max: number): Validator {
  return (value, path) => {
    const errs = isNumber(value, path);
    if (errs.length) return errs;
    if ((value as number) < min || (value as number) > max)
      return [`${path}: expected ${min}–${max}, got ${value}`];
    return [];
  };
}

function isHexColor(value: unknown, path: string): string[] {
  if (typeof value !== 'string') return [`${path}: expected hex color string`];
  if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) return [`${path}: invalid hex color "${value}"`];
  return [];
}

function hasFields(
  obj: Record<string, unknown>,
  fields: Record<string, Validator>,
  basePath: string,
): string[] {
  const errors: string[] = [];
  for (const [key, validator] of Object.entries(fields)) {
    errors.push(...validator(obj[key], `${basePath}.${key}`));
  }
  return errors;
}

// ─── Color Object ────────────────────────────────────────────

function validateColors(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  return hasFields(
    obj,
    {
      pre: isHexColor,
      active: isHexColor,
      post: isHexColor,
    },
    path,
  );
}

// ─── Theme ──────────────────────────────────────────────────

function validateTheme(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  return hasFields(
    obj,
    {
      fontSize: isNumber,
      fontId: isString,
      colors: validateColors,
      verticalPosition: isNumberInRange(0, 100),
      effectScope: isOneOf(['word', 'line', 'background'] as const),
      wordSpacing: isNumber,
      glowEnabled: isOptional(isBoolean),
      glowColor: isOptional(isHexColor),
      glowIntensity: isOptional(isNumberInRange(0, 5)),
      outlineColor: isOptional(isHexColor),
      fadeInDuration: isOptional(isNumber),
      fadeOutDuration: isOptional(isNumber),
    },
    path,
  );
}

// ─── Animation ──────────────────────────────────────────────

const ANIMATION_TYPES = ['none', 'fadeIn', 'flyIn', 'slideUp', 'popIn', 'typewriter'] as const;
const STAGGER_TYPES = ['letter', 'word', 'line'] as const;

function validateAnimation(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  return hasFields(
    obj,
    {
      type: isOneOf(ANIMATION_TYPES),
      stagger: isOneOf(STAGGER_TYPES),
      activeScale: isBoolean,
    },
    path,
  );
}

// ─── Meta ───────────────────────────────────────────────────

function validateMeta(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  return hasFields(
    obj,
    {
      name: isString,
      artist: isOptional(isString),
      createdAt: isOptional(isString),
      created: isOptional(isString),
    },
    path,
  );
}

// ─── Lyric Line ─────────────────────────────────────────────

function validateLyricLine(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];

  // Must have words array
  if (!Array.isArray(obj.words)) {
    errors.push(`${path}.words: expected array`);
  } else {
    for (let i = 0; i < obj.words.length; i++) {
      const word = obj.words[i] as Record<string, unknown>;
      if (typeof word !== 'object' || word === null) {
        errors.push(`${path}.words[${i}]: expected object`);
        continue;
      }
      if (typeof word.text !== 'string') errors.push(`${path}.words[${i}].text: expected string`);
      if (typeof word.startTime !== 'number')
        errors.push(`${path}.words[${i}].startTime: expected number`);
      if (typeof word.endTime !== 'number')
        errors.push(`${path}.words[${i}].endTime: expected number`);
    }
  }

  return errors;
}

// ─── Track ──────────────────────────────────────────────────

function validateTrackData(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];

  errors.push(
    ...hasFields(
      obj,
      {
        id: isString,
        name: isString,
        duration: isNumber,
      },
      path,
    ),
  );

  // Validate lyrics array if present
  if (obj.lyrics !== undefined) {
    const lyricsErrors = isArray(obj.lyrics, `${path}.lyrics`);
    if (lyricsErrors.length === 0) {
      const lyrics = obj.lyrics as unknown[];
      for (let i = 0; i < Math.min(lyrics.length, 5); i++) {
        errors.push(...validateLyricLine(lyrics[i], `${path}.lyrics[${i}]`));
      }
    } else {
      errors.push(...lyricsErrors);
    }
  }

  // Validate keyframes array if present
  if (obj.keyframes !== undefined && obj.keyframes !== null) {
    const kfErrors = isArray(obj.keyframes, `${path}.keyframes`);
    if (kfErrors.length === 0) {
      const keyframes = obj.keyframes as Record<string, unknown>[];
      for (let i = 0; i < Math.min(keyframes.length, 3); i++) {
        if (typeof keyframes[i]?.time !== 'number') {
          errors.push(`${path}.keyframes[${i}].time: expected number`);
        }
      }
    } else {
      errors.push(...kfErrors);
    }
  }

  return errors;
}

// ─── Effects Config ─────────────────────────────────────────

function validateEffectsConfig(value: unknown, path: string): string[] {
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];

  // effectInstances must be an array
  if (obj.effectInstances !== undefined) {
    const arrErr = isArray(obj.effectInstances, `${path}.effectInstances`);
    if (arrErr.length) {
      errors.push(...arrErr);
    } else {
      const instances = obj.effectInstances as Record<string, unknown>[];
      for (let i = 0; i < Math.min(instances.length, 5); i++) {
        if (typeof instances[i] !== 'object' || instances[i] === null) {
          errors.push(`${path}.effectInstances[${i}]: expected object`);
          continue;
        }
        if (typeof instances[i].id !== 'string')
          errors.push(`${path}.effectInstances[${i}].id: expected string`);
        if (typeof instances[i].type !== 'string')
          errors.push(`${path}.effectInstances[${i}].type: expected string`);
      }
    }
  }

  return errors;
}

// ─── Export Settings ────────────────────────────────────────

function validateExportSettings(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  const e = isObject(value, path);
  if (e.length) return e;
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.width !== undefined) errors.push(...isNumber(obj.width, `${path}.width`));
  if (obj.height !== undefined) errors.push(...isNumber(obj.height, `${path}.height`));
  if (obj.quality !== undefined) errors.push(...isString(obj.quality, `${path}.quality`));
  if (obj.aspect !== undefined) errors.push(...isString(obj.aspect, `${path}.aspect`));
  if (obj.codec !== undefined) errors.push(...isString(obj.codec, `${path}.codec`));
  if (obj.fps !== undefined) errors.push(...isString(obj.fps, `${path}.fps`));
  if (obj.bitrate !== undefined) errors.push(...isString(obj.bitrate, `${path}.bitrate`));

  return errors;
}

// ─── Main Validators ────────────────────────────────────────

/**
 * Validate a ThrenicProject JSON object.
 * Returns detailed validation errors and warnings.
 */
export function validateProject(data: unknown): ProjectValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Top-level structure
  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Root: expected an object'], warnings };
  }

  const obj = data as Record<string, unknown>;

  // Version check
  if (obj.version !== undefined) {
    if (typeof obj.version !== 'string') {
      errors.push('version: expected string');
    } else if (obj.version !== PROJECT_VERSION) {
      warnings.push(
        `version: "${obj.version}" differs from current "${PROJECT_VERSION}" — migration may be needed`,
      );
    }
  } else {
    warnings.push('version: missing — assuming current version');
  }

  // Meta
  if (obj.meta !== undefined) {
    errors.push(...validateMeta(obj.meta, 'meta'));
  } else {
    warnings.push('meta: missing — no project metadata');
  }

  // Theme
  if (obj.theme !== undefined) {
    errors.push(...validateTheme(obj.theme, 'theme'));
  }

  // Animation
  if (obj.animation !== undefined) {
    errors.push(...validateAnimation(obj.animation, 'animation'));
  }

  // Effects
  if (obj.effects !== undefined) {
    errors.push(...validateEffectsConfig(obj.effects, 'effects'));
  }

  // Playlist tracks
  if (obj.playlist !== undefined) {
    const arrErr = isArray(obj.playlist, 'playlist');
    if (arrErr.length) {
      errors.push(...arrErr);
    } else {
      const tracks = obj.playlist as unknown[];
      if (tracks.length === 0) {
        warnings.push('playlist: empty track list');
      }
      for (let i = 0; i < tracks.length; i++) {
        errors.push(...validateTrackData(tracks[i], `playlist[${i}]`));
      }
    }
  }

  // Lyrics
  if (obj.lyrics !== undefined) {
    const lyricsObj = obj.lyrics as Record<string, unknown>;
    if (typeof lyricsObj === 'object' && lyricsObj !== null) {
      if (lyricsObj.lines !== undefined) {
        const arrErr = isArray(lyricsObj.lines, 'lyrics.lines');
        if (arrErr.length) {
          errors.push(...arrErr);
        }
      }
    }
  }

  // Export settings
  if (obj.exportSettings !== undefined) {
    errors.push(...validateExportSettings(obj.exportSettings, 'exportSettings'));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
