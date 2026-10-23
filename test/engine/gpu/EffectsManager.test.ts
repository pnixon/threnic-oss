import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EffectsManager, mergeColorGradeState } from '@/engine/gpu/EffectsManager';
import type { RenderGraph } from '@/engine/gpu/RenderGraph';
import type { EffectInstance } from '@/types/effects/effect-instances';
import { BLOOM_PASS_ID, COLOR_GRADE_PASS_ID } from '@/engine/gpu/EffectPasses';

describe('EffectsManager', () => {
  let mockRenderGraph: any;
  let effectsManager: EffectsManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRenderGraph = {
      registerPass: vi.fn().mockResolvedValue(true),
      unregisterPass: vi.fn(),
      hasPass: vi.fn().mockReturnValue(false),
      setPassUniformUpdater: vi.fn(),
      setPassEnabled: vi.fn(),
      setPassOrder: vi.fn(),
    };

    effectsManager = new EffectsManager(mockRenderGraph as unknown as RenderGraph);
  });

  describe('resolveNeededPasses', () => {
    it('should resolve bloom pass when bloom effect is enabled', () => {
      const instances: EffectInstance[] = [
        { id: '1', type: 'bloom', config: { enabled: true } } as any,
      ];
      const needed = effectsManager.resolveNeededPasses(instances);
      expect(needed.has(BLOOM_PASS_ID)).toBe(true);
    });

    it('should resolve color grade pass for brightness/contrast effects', () => {
      const instances: EffectInstance[] = [
        { id: '1', type: 'brightness', config: { enabled: true } } as any,
        { id: '2', type: 'contrast', config: { enabled: true } } as any,
      ];
      const needed = effectsManager.resolveNeededPasses(instances);
      expect(needed.has(COLOR_GRADE_PASS_ID)).toBe(true);
    });

    it('should not resolve disabled effects', () => {
      const instances: EffectInstance[] = [
        { id: '1', type: 'bloom', config: { enabled: false } } as any,
      ];
      const needed = effectsManager.resolveNeededPasses(instances);
      expect(needed.size).toBe(0);
    });
  });

  describe('ensurePassesRegistered', () => {
    it('should register bloom pass if not registered', async () => {
      const needed = new Set([BLOOM_PASS_ID]);
      await effectsManager.ensurePassesRegistered(needed);

      expect(mockRenderGraph.registerPass).toHaveBeenCalled();
      expect(mockRenderGraph.setPassUniformUpdater).toHaveBeenCalledWith(
        BLOOM_PASS_ID,
        expect.any(Function),
      );
    });

    it('should skip if pass is already registered on graph', async () => {
      mockRenderGraph.hasPass.mockReturnValue(true);
      const needed = new Set([BLOOM_PASS_ID]);
      await effectsManager.ensurePassesRegistered(needed);

      expect(mockRenderGraph.registerPass).not.toHaveBeenCalled();
    });
  });

  describe('syncFrame', () => {
    it('should extract state and enable passes', async () => {
      const effectsConfig = {
        effectInstances: [
          { id: '1', type: 'bloom', config: { enabled: true, intensity: 0.8 } } as any,
        ],
      };

      // Use syncFrameAsync to wait for pass registration
      await effectsManager.syncFrameAsync(effectsConfig as any);

      // Should have triggered registration
      expect(mockRenderGraph.registerPass).toHaveBeenCalled();

      // Should enable the pass
      expect(mockRenderGraph.setPassEnabled).toHaveBeenCalledWith(BLOOM_PASS_ID, true);
    });

    it('should disable passes that are no longer needed', async () => {
      // First sync with bloom
      await effectsManager.syncFrameAsync({
        effectInstances: [{ id: '1', type: 'bloom', config: { enabled: true } } as any],
      } as any);

      // Second sync without bloom
      await effectsManager.syncFrameAsync({
        effectInstances: [],
      } as any);

      expect(mockRenderGraph.setPassEnabled).toHaveBeenCalledWith(BLOOM_PASS_ID, false);
    });
  });

  describe('mergeColorGradeState', () => {
    it('should multiply brightness from multiple instances', () => {
      const instances: EffectInstance[] = [
        { id: '1', type: 'brightness', config: { enabled: true, brightness: 1.5 } } as any,
        { id: '2', type: 'brightness', config: { enabled: true, brightness: 2.0 } } as any,
      ];
      const merged = mergeColorGradeState(instances);
      expect(merged.brightness).toBe(3.0);
    });
  });
});
