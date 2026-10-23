/**
 * Visualizer Configuration
 */
export interface VisualizerConfig {
  enabled: boolean;
  type: 'linear' | 'circle' | 'bars' | 'tunnel';
  style: 'classic' | 'retro' | 'modern' | 'lasers' | 'blocky';
  minColor: string; // Color at low intensity
  maxColor: string; // Color at high intensity
  glowIntensity: number;
  lineWidth: number;
  sensitivity: number;
  smoothness: number;
  attack: number;
  decay: number;
  positionX: number;
  positionY: number;
  scale: number;
  backgroundColor: string;
  opacity?: number;
}
