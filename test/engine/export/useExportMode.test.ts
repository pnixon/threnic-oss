import { renderHook, act } from '@testing-library/react';
import { useExportMode } from '@/engine/export/useExportMode';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/engine/export/StreamableExportController', () => ({
  StreamableExportController: {
    isSupported: vi.fn(() => true),
  },
}));

describe('useExportMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useExportMode());

    expect(result.current.isExporting).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.selectedFps).toBe(24);
    expect(result.current.isSupported).toBe(true);
  });

  it('updates selected FPS', () => {
    const { result } = renderHook(() => useExportMode());

    act(() => {
      result.current.setSelectedFps(30);
    });

    expect(result.current.selectedFps).toBe(30);
  });

  it('updates configuration', () => {
    const { result } = renderHook(() => useExportMode());

    act(() => {
      result.current.setConfig((prev: any) => ({
        ...prev,
        mode: 'batch',
      }));
    });

    expect(result.current.config.mode).toBe('batch');
  });

  it('cancels export by setting the global flag', () => {
    const { result } = renderHook(() => useExportMode());

    expect(() => {
      act(() => {
        result.current.cancelExport();
      });
    }).not.toThrow();
  });
});
