import React from 'react';
import { Info, Copy } from 'lucide-react';
import { CollapsibleSection } from '../../CollapsibleSection';
import { EFFECT_LABELS } from '@/types/effects/effect-instances';
import type { EffectsConfig } from '@/types/effects';
import styles from './EffectsSummarySection.module.css';

type SummaryReactiveValue = { enabled?: unknown; band?: unknown; multiplier?: unknown };

/**
 * Builds a human-readable, copy-pasteable summary of the active visual effects
 * for a track. Moved out of the Export tab so effect authoring and its summary
 * live together on the Effects tab.
 */
function generateHumanReadableSummary(config: EffectsConfig): string {
  let summary = 'Visual Effects Summary:\n';
  let hasEffects = false;

  const listProps = (
    sectionName: string,
    section: object | null | undefined,
    indent: string = '  ',
  ) => {
    const current = section as Record<string, unknown> | null | undefined;
    if (!current || current.enabled === false) return '';

    let sectionSummary = `${indent}- ${sectionName}:\n`;
    let propCount = 0;

    Object.keys(current).forEach((key) => {
      if (key === 'enabled' || key === 'id') return;

      const val = current[key] as SummaryReactiveValue;

      // Flat audio-reactive config
      if (key === 'audioReactive') {
        if (val.enabled) {
          sectionSummary += `${indent}  - Audio Reaction: ${val.band} band, x${val.multiplier}\n`;
          propCount++;
        }
        return;
      }

      // Grouped audio-reactive objects (like bloom.audioReactive.intensity)
      if (typeof val === 'object' && val !== null && val.enabled !== undefined) {
        if (val.enabled) {
          sectionSummary += `${indent}  - ${key} (AR): ${val.band} band, x${val.multiplier}\n`;
          propCount++;
        }
        return;
      }

      // Skip other complex objects for simplicity in the summary
      if (typeof val === 'object' && val !== null) return;

      sectionSummary += `${indent}  - ${key}: ${val}\n`;
      propCount++;
    });

    return propCount > 0 ? sectionSummary : `${indent}- ${sectionName} (Active)\n`;
  };

  // 1. New instanced effects
  if (config.effectInstances && config.effectInstances.length > 0) {
    summary += 'Active Effect Layers:\n';
    config.effectInstances.forEach((inst, idx) => {
      const typeLabel = EFFECT_LABELS[inst.type] || inst.type;
      const layerSummary = listProps(`${idx + 1}. ${typeLabel}`, inst.config);
      if (layerSummary) {
        summary += layerSummary;
        hasEffects = true;
      }
    });
  }

  // 2. Legacy effects (backward compat)
  if (!hasEffects) {
    if (config.postProcessing) {
      Object.entries(config.postProcessing).forEach(
        ([key, effect]: [string, { enabled?: boolean } | undefined]) => {
          if (effect?.enabled) {
            const name = key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
            summary += listProps(name, effect);
            hasEffects = true;
          }
        },
      );
    }

    if (config.particles?.enabled) {
      summary += listProps('Particles (Legacy)', config.particles);
      hasEffects = true;
    }
    if (config.rain?.enabled) {
      summary += listProps('Rain (Legacy)', config.rain);
      hasEffects = true;
    }
    if (config.visualizer?.enabled) {
      summary += listProps('Oscilloscope (Legacy)', config.visualizer);
      hasEffects = true;
    }
  }

  if (!hasEffects) return 'No active effects configured.';

  return summary;
}

interface EffectsSummarySectionProps {
  effectsConfig: EffectsConfig | undefined;
  forceOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
}

export function EffectsSummarySection({
  effectsConfig,
  forceOpen,
  open,
  onToggle,
}: EffectsSummarySectionProps) {
  const summary = effectsConfig
    ? generateHumanReadableSummary(effectsConfig)
    : 'No configuration found';

  return (
    <CollapsibleSection
      title="Effects Summary"
      icon={<Info size={14} />}
      forceOpen={forceOpen}
      open={open}
      onToggle={onToggle}
    >
      <div className={styles.summaryContainer}>
        <button
          onClick={() => navigator.clipboard.writeText(summary)}
          className={styles.copyBtn}
          title="Copy Summary"
        >
          <Copy size={12} />
        </button>
        <textarea
          className={styles.summaryTextarea}
          readOnly
          value={summary}
          onClick={(e) => e.currentTarget.select()}
        />
      </div>
    </CollapsibleSection>
  );
}
