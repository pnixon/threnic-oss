/**
 * Effect Schema Types
 *
 * Defines a declarative schema for effect editors. Each effect exports
 * an EffectSchema that describes its configurable fields, and the
 * GenericEffectEditor reads this to render the appropriate controls.
 */

// ---------------------------------------------------------------------------
// Field Types
// ---------------------------------------------------------------------------

/** All supported control types in the effect editor */
type FieldType =
  | 'slider'
  | 'logSlider'
  | 'color'
  | 'select'
  | 'checkbox'
  | 'buttonGroup'
  | 'range'
  | 'butterchurnPresetPicker'
  | 'triggerLevel'
  | 'imageUpload';

/** Audio-reactive binding for a field */
interface AudioReactiveDef {
  /** Path to the AR config within the effect's config object.
   *  Examples:
   *    'audioReactive'                 → config.audioReactive
   *    'audioReactive.intensity'       → config.audioReactive.intensity
   *    'audioReactive.speed'           → config.audioReactive.speed
   */
  path: string;
  /** Label shown on the AR editor (defaults to the field's label) */
  label?: string;
  /** AR min/max for the box plot graph */
  min?: number;
  max?: number;
  step?: number;
  /** If true, hide the base slider when AR is enabled (default: true) */
  hideBaseWhenActive?: boolean;
  /** Info text shown when AR is active and the base control is hidden */
  infoText?: string;
}

/** Display scale transform for fields where the raw config value is
 *  inconvenient for the user. The slider/AR shows value * displayScale,
 *  and the stored value is slider / displayScale.
 *  Example: chromaticAberration.offset is stored as 0-0.05 but shown as 0-10 (scale=200).
 */
interface DisplayScaleDef {
  /** Multiply the raw config value by this to get the display value */
  scale: number;
}

/** A single configurable field */
export interface FieldDef {
  type: FieldType;
  /** Property key on the config object (e.g. 'intensity', 'sparkColor').
   *  Supports dot-notation for nested props: 'randomInterval.min'
   */
  property?: string;
  /** Display label */
  label: string;
  /** For slider/logSlider: min, max, step */
  min?: number;
  max?: number;
  step?: number;
  /** Default value when not present in config */
  default?: number | string | boolean | Record<string, unknown>;

  // -- Range Slider --
  propertyLow?: string;
  propertyHigh?: string;
  defaultLow?: number;
  defaultHigh?: number;

  // -- Select / ButtonGroup / Checkbox --

  /** For select and buttonGroup: option list */
  options?: { value: string; label: string }[];
  /** For select: load options dynamically from a registered provider (key name) */
  dynamicOptionsKey?: string;
  /** For checkbox: secondary label text */
  checkboxLabel?: string;

  // -- Audio Reactive --

  /** If set, this field gets an AudioReactiveEditor paired with it */
  audioReactive?: AudioReactiveDef;

  // -- Conditional visibility --

  /** Only show this field when another field matches a value */
  showWhen?: {
    field: string;
    /** Match if value equals this, OR if value is in this array */
    value: string | boolean | number | (string | boolean | number)[];
    /** If true, show when field does NOT match value (i.e. "not equals") */
    negate?: boolean;
  };

  // -- Layout --

  /** Optional group id to visually group fields (rendered as collapsible sections) */
  group?: string;
  /** Hint text shown below the field */
  hint?: string;
  /** If true, a divider line is rendered after this field */
  dividerAfter?: boolean;

  // -- Value Transforms --

  /** Transform value before storing (e.g. 'round' for integer fields) */
  transform?: 'round' | 'none';
  /** Display scale: slider shows value*scale, stores value/scale */
  displayScale?: DisplayScaleDef;

  // -- Section headers --

  /** If set, renders a small section header label above this field */
  sectionHeader?: string;
}

// ---------------------------------------------------------------------------
// Groups (collapsible sections)
// ---------------------------------------------------------------------------

/** A group/section header for organizing fields into collapsible panels */
export interface GroupDef {
  id: string;
  label: string;
  /** Lucide icon name (optional) */
  icon?: string;
  /** Whether this group starts open (default: true) */
  defaultOpen?: boolean;
}

// ---------------------------------------------------------------------------
// The Schema
// ---------------------------------------------------------------------------

/** Complete schema for an effect's editor UI */
export interface EffectSchema {
  /** Unique effect type key (matches EffectInstance.type) */
  type: string;
  /** Human-readable name (for labels / display) */
  label: string;
  /** Field definitions, rendered in order */
  fields: FieldDef[];
  /** Optional groups for collapsible sections */
  groups?: GroupDef[];
  /**
   * Optional informational note rendered at the top of the editor, under the
   * header. Use for caveats about where an effect applies.
   */
  note?: {
    /** The message shown to the user. */
    text: string;
    /**
     * When true, the note is only shown while a Shader FX instance
     * (fragment shader / game scene / butterchurn) is enabled — e.g. background
     * transform effects (slide, rotate) do not affect shader-driven backgrounds.
     */
    onlyWhenShaderFxEnabled?: boolean;
  };
}
