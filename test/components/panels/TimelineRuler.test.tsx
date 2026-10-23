import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { TimelineRuler } from '@/components/panels/Timeline/Tracks/TimelineRuler';

describe('TimelineRuler', () => {
  const fillText = vi.fn();
  const ctx = {
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText,
  };

  beforeEach(() => {
    fillText.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws second labels across the visible range', () => {
    const { container } = render(
      <TimelineRuler zoom={100} width={500} height={34} viewOffsetRef={{ current: 0 }} />,
    );

    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(500);
    expect(canvas.height).toBe(34);
    // zoom 100px/s → 1s major ticks at x = 0, 100, 200, ...
    expect(fillText.mock.calls.map((call) => call[0]).slice(0, 5)).toEqual([
      '0s',
      '1s',
      '2s',
      '3s',
      '4s',
    ]);
    expect(fillText.mock.calls[2][1]).toBeCloseTo(200);
  });

  it('follows the timeline scroll offset', () => {
    render(<TimelineRuler zoom={100} width={300} height={34} viewOffsetRef={{ current: 0 }} />);
    fillText.mockClear();

    window.dispatchEvent(new CustomEvent('threnicViewOffset', { detail: { scrollLeft: 6000 } }));

    expect(fillText.mock.calls.map((call) => call[0]).slice(0, 3)).toEqual([
      '1:00',
      '1:01',
      '1:02',
    ]);
  });

  it('does not draw while the panel is hidden or unmeasured', () => {
    render(
      <TimelineRuler
        zoom={100}
        width={500}
        height={34}
        viewOffsetRef={{ current: 0 }}
        isVisible={false}
      />,
    );
    render(<TimelineRuler zoom={100} width={0} height={34} viewOffsetRef={{ current: 0 }} />);

    expect(fillText).not.toHaveBeenCalled();
  });
});
