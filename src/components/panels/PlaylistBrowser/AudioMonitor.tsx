import React, { useRef, useEffect, useState } from 'react';
import { audioStore } from '../../../engine/stores/audioStore';
import { BandMeterWidget } from '../Inspector/BandMeterWidget';

interface AudioMonitorProps {
  isVisible?: boolean;
}

// --- MAIN COMPONENT ---
function AudioMonitor({ isVisible = true }: AudioMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const [mode, setMode] = useState<'spectrum' | 'oscilloscope' | 'meters'>('spectrum');
  const modeRef = useRef(mode);

  // Dynamic persistent caches for 3-layered rendering streams
  const fastSpectrumRef = useRef(new Float32Array(64));
  const midSpectrumRef = useRef(new Float32Array(64));
  const slowSpectrumRef = useRef(new Float32Array(64));

  const fastOscilloscopeRef = useRef(new Float32Array(128));
  const midOscilloscopeRef = useRef(new Float32Array(128));
  const slowOscilloscopeRef = useRef(new Float32Array(128));

  const themeColorsRef = useRef({
    bg: '#050508',
    accent: '#ef4444',
    text: '#ffffff',
    border: 'rgba(255, 255, 255, 0.1)',
  });

  // Sync mode state to ref for RAF loop
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Update theme colors from CSS variables
  useEffect(() => {
    const updateColors = () => {
      const style = getComputedStyle(document.documentElement);
      themeColorsRef.current = {
        bg: style.getPropertyValue('--bg-app').trim() || '#050508',
        accent: style.getPropertyValue('--accent-main').trim() || '#ef4444',
        text: style.getPropertyValue('--text-primary').trim() || '#ffffff',
        border: style.getPropertyValue('--border-subtle').trim() || 'rgba(255, 255, 255, 0.1)',
      };
    };

    updateColors();
    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const drawGrid = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const colors = themeColorsRef.current;
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.05;
    const cols = 8;
    const rows = 4;
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const x = (w / cols) * i;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let i = 0; i <= rows; i++) {
      const y = (h / rows) * i;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  };

  useEffect(() => {
    if (!isVisible || mode === 'meters') {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const resize = () => {
      const parent = canvas.parentElement;
      if (parent && parent.clientWidth > 0 && parent.clientHeight > 0) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
    });

    if (canvas.parentElement) {
      resizeObserver.observe(canvas.parentElement);
    }

    // Initial resize
    resize();

    let wasSilent = false;

    const render = () => {
      // Schedule next frame
      animationRef.current = requestAnimationFrame(render);

      const { fftData, timeDomainData, audioContext } = audioStore.getState();
      const currentMode = modeRef.current;

      let isSilent = true;
      const isRunning = audioContext?.state === 'running';

      if (isRunning) {
        if (currentMode === 'spectrum') {
          // Sample a few bins to quickly check if silent
          for (let i = 0; i < 64; i += 4) {
            if (fftData[i] > 0) {
              isSilent = false;
              break;
            }
          }
        } else {
          // In oscilloscope, check if values deviate from zero-crossing (128)
          for (let i = 0; i < 128; i += 8) {
            const val = timeDomainData[Math.floor(i * (timeDomainData.length / 128))];
            if (Math.abs(val - 128) > 2) {
              isSilent = false;
              break;
            }
          }
        }
      }

      // Skip rendering if not running/silent and we already drew a zero frame
      if ((!isRunning || isSilent) && wasSilent) {
        return;
      }

      wasSilent = isSilent;

      const colors = themeColorsRef.current;
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      drawGrid(ctx, width, height);

      // Draw faint center zero-crossing line for oscilloscope
      if (currentMode === 'oscilloscope') {
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }

      const mainColor = colors.accent;
      const coreColor = colors.text;

      if (currentMode === 'spectrum') {
        // --- 3-LAYER LOGARITHMIC SPECTRUM ANALYZER ---
        const numPoints = 64;
        const sliceWidth = width / numPoints;

        // 1. Process 3 independent attack/decay layers
        for (let i = 0; i < numPoints; i++) {
          const percent = i / (numPoints - 1);
          // Logarithmic frequency mapping
          const logIndex = Math.floor(
            ((Math.pow(2, percent * 8) - 1) / 255) * (fftData.length * 0.5),
          );
          const rawVal = fftData[Math.min(fftData.length - 1, logIndex)] / 255;

          fastSpectrumRef.current[i] += (rawVal - fastSpectrumRef.current[i]) * 0.35;
          midSpectrumRef.current[i] += (rawVal - midSpectrumRef.current[i]) * 0.12;
          slowSpectrumRef.current[i] += (rawVal - slowSpectrumRef.current[i]) * 0.04;
        }

        // Helper to draw a quadratic curve path from a data stream
        const drawCurvePath = (dataStream: Float32Array) => {
          ctx.beginPath();
          for (let i = 0; i < numPoints; i++) {
            const val = dataStream[i];
            const x = i * sliceWidth;
            const y = height - val * height * 0.96;

            if (i === 0) ctx.moveTo(x, y);
            else {
              const prevX = (i - 1) * sliceWidth;
              const prevY = height - dataStream[i - 1] * height * 0.96;
              const cpX = (prevX + x) / 2;
              ctx.quadraticCurveTo(cpX, prevY, x, y);
            }
          }
        };

        // LAYER 3: Slow Background Mountain Envelope (Filled Area)
        drawCurvePath(slowSpectrumRef.current);
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.globalAlpha = 0.07; // Safe native opacity fill
        ctx.fillStyle = mainColor;
        ctx.fill();
        ctx.globalAlpha = 1.0;

        // LAYER 2: Mid Glowing Trail (Thick Stroke)
        drawCurvePath(midSpectrumRef.current);
        ctx.globalAlpha = 0.22; // Safe native opacity stroke
        ctx.strokeStyle = mainColor;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.globalAlpha = 1.0;

        // LAYER 1: Fast Core Line (Thin Core stroke)
        drawCurvePath(fastSpectrumRef.current);
        ctx.strokeStyle = coreColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      } else {
        // --- 3-LAYER TIME-DOMAIN OSCILLOSCOPE ---
        const numPoints = 128;
        const sliceWidth = width / numPoints;
        const step = Math.floor(timeDomainData.length / numPoints);

        // 1. Process 3 independent layers
        for (let i = 0; i < numPoints; i++) {
          const rawVal =
            (timeDomainData[Math.min(timeDomainData.length - 1, i * step)] - 128) / 128;

          fastOscilloscopeRef.current[i] += (rawVal - fastOscilloscopeRef.current[i]) * 0.35;
          midOscilloscopeRef.current[i] += (rawVal - midOscilloscopeRef.current[i]) * 0.12;
          slowOscilloscopeRef.current[i] += (rawVal - slowOscilloscopeRef.current[i]) * 0.04;
        }

        const drawWavePath = (dataStream: Float32Array) => {
          ctx.beginPath();
          for (let i = 0; i < numPoints; i++) {
            const val = dataStream[i];
            const x = i * sliceWidth;
            const y = height / 2 + val * (height / 2) * 0.96;

            if (i === 0) ctx.moveTo(x, y);
            else {
              const prevX = (i - 1) * sliceWidth;
              const prevY = height / 2 + dataStream[i - 1] * (height / 2) * 0.96;
              const cpX = (prevX + x) / 2;
              ctx.quadraticCurveTo(cpX, prevY, x, y);
            }
          }
        };

        // LAYER 3: Slow Boundary Glow
        drawWavePath(slowOscilloscopeRef.current);
        ctx.globalAlpha = 0.06;
        ctx.strokeStyle = mainColor;
        ctx.lineWidth = 10;
        ctx.stroke();
        ctx.globalAlpha = 1.0;

        // LAYER 2: Mid Waveform Glow
        drawWavePath(midOscilloscopeRef.current);
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = mainColor;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.globalAlpha = 1.0;

        // LAYER 1: Fast Core Waveform
        drawWavePath(fastOscilloscopeRef.current);
        ctx.strokeStyle = coreColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // --- GLOWING LASER EFFECT (OUTLINE ONLY) ---
      // Check if high contrast
      const isHighContrast =
        document.documentElement.getAttribute('data-theme') === 'high-contrast';

      if (!isHighContrast) {
        // 1. Wide Outer Glow
        ctx.globalAlpha = 0.07;
        ctx.lineWidth = 12;
        ctx.strokeStyle = mainColor;
        ctx.stroke();

        // 2. Medium Glow
        ctx.globalAlpha = 0.13;
        ctx.lineWidth = 6;
        ctx.strokeStyle = mainColor;
        ctx.stroke();

        // 3. Tight Glow
        ctx.globalAlpha = 0.27;
        ctx.lineWidth = 3;
        ctx.strokeStyle = mainColor;
        ctx.shadowBlur = 10;
        ctx.shadowColor = mainColor;
        ctx.stroke();
      }

      // 4. Bright Core
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = coreColor;
      ctx.globalAlpha = 0.8;
      ctx.stroke();

      ctx.globalAlpha = 1.0;
    };

    // Start loop
    animationRef.current = requestAnimationFrame(render);

    return () => {
      resizeObserver.disconnect();
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isVisible, mode]);

  return (
    <div className="relative w-full h-full flex bg-[var(--bg-app)] rounded-md overflow-hidden border border-[var(--border-subtle)] shadow-[var(--shadow-inset)]">
      {/* Visualization Content */}
      {mode === 'meters' ? (
        <div className="flex-grow relative h-full bg-[var(--bg-input)]/30 p-2">
          <BandMeterWidget isVisible={isVisible} />
        </div>
      ) : (
        <div className="flex-grow relative h-full bg-[var(--bg-input)]/30">
          <canvas ref={canvasRef} className="block w-full h-full" />
        </div>
      )}

      {/* Mode Switcher Overlay - anchored bottom-right, above meter bars */}
      <div className="absolute bottom-2 right-2 flex gap-1 z-50 bg-black/60 backdrop-blur-md p-0.5 rounded border border-white/10 text-[9px] font-semibold font-mono">
        <button
          onClick={() => setMode('spectrum')}
          className={`px-1.5 py-0.5 rounded transition-colors ${
            mode === 'spectrum'
              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
              : 'text-gray-400 border border-transparent hover:text-white'
          }`}
        >
          Spectrum
        </button>
        <button
          onClick={() => setMode('oscilloscope')}
          className={`px-1.5 py-0.5 rounded transition-colors ${
            mode === 'oscilloscope'
              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
              : 'text-gray-400 border border-transparent hover:text-white'
          }`}
        >
          Scope
        </button>
        <button
          onClick={() => setMode('meters')}
          className={`px-1.5 py-0.5 rounded transition-colors ${
            mode === 'meters'
              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
              : 'text-gray-400 border border-transparent hover:text-white'
          }`}
        >
          Meters
        </button>
      </div>

      {/* Global Overlay: Subtle Scanlines for Industrial Look - hide in HC */}
      {mode !== 'meters' && (
        <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] [data-theme='high-contrast']:hidden"></div>
      )}
    </div>
  );
}

export default AudioMonitor;
