import React, { useRef, useEffect } from 'react';
import { audioStore } from '../../../engine/stores/audioStore';

// --- DIGITAL SEGMENTED LED METER COMPONENT ---
const LedMeterButton = ({
  label,
  fastRef,
  midRef,
  slowRef,
  peakRef,
  clipRef,
}: {
  label: string;
  fastRef: React.RefObject<HTMLDivElement | null>;
  midRef: React.RefObject<HTMLDivElement | null>;
  slowRef: React.RefObject<HTMLDivElement | null>;
  peakRef: React.RefObject<HTMLDivElement | null>;
  clipRef: React.RefObject<HTMLDivElement | null>;
}) => {
  return (
    <div className="flex flex-col items-center group relative flex-1 min-w-0 font-sans">
      {/* Recessed Modular Digital Grid Slot - themes automatically */}
      <div
        className="relative w-full h-40 rounded-[2px] transition-all duration-200 overflow-hidden"
        style={{
          background: `var(--bg-input, rgba(5, 5, 8, 0.75))`,
          border: '1px solid rgba(255, 255, 255, 0.05)',
          boxShadow: `
            inset 0 3px 6px rgba(0,0,0,0.85),
            inset 0 0 0 1px rgba(255,255,255,0.02)
          `,
        }}
      >
        {/* Background Trace (Unlit LED grid silhouette) */}
        <div
          className="absolute inset-x-[40%] bottom-1 top-1 opacity-[0.03] rounded-[1px]"
          style={{ backgroundColor: 'var(--accent-main, #ef4444)' }}
        />

        {/* 1. LAYER 3: Slow Average Base (Wide Low-Opacity) */}
        <div
          ref={slowRef}
          className="absolute inset-x-[1px] bottom-[2px] top-[2px] pointer-events-none rounded-[1px] will-change-transform"
          style={{
            transform: 'translateY(100%)',
            background: 'var(--accent-glow, rgba(239, 68, 68, 0.15))',
          }}
        />

        {/* 2. LAYER 2: Mid Envelope Glow (Medium-Width) */}
        <div
          ref={midRef}
          className="absolute inset-x-[3px] bottom-[2px] top-[2px] pointer-events-none rounded-[1px] will-change-transform"
          style={{
            transform: 'translateY(100%)',
            border: `1px solid var(--accent-main, #ef4444)`,
            background: `linear-gradient(90deg, 
              rgba(0,0,0,0.4) 0%, 
              var(--accent-main, #ef4444) 50%, 
              rgba(0,0,0,0.4) 100%
            )`,
            opacity: 0.5,
          }}
        />

        {/* 3. LAYER 1: Fast Core Filament (Thin Bright Core) */}
        <div
          ref={fastRef}
          className="absolute inset-x-[5px] bottom-[2px] top-[2px] pointer-events-none rounded-[1px] will-change-transform z-10"
          style={{
            transform: 'translateY(100%)',
            background: `linear-gradient(to top, 
              var(--accent-main, #ef4444) 0%, 
              #f59e0b 70%, 
              #ef4444 90%, 
              #ffffff 100%
            )`,
            opacity: 0.9,
            boxShadow: `0 0 10px var(--accent-main, #ef4444)`,
          }}
        />

        {/* Peak-Hold Segment (Discrete 6px Horizontal LED block) */}
        <div
          ref={peakRef}
          className="absolute inset-x-[1px] bottom-[2px] top-[2px] pointer-events-none will-change-transform z-20"
          style={{
            transform: 'translateY(100%)',
          }}
        >
          <div
            className="w-full h-[6px] rounded-[1px] bg-white"
            style={{
              boxShadow: `0 0 8px var(--accent-main, #ef4444)`,
            }}
          />
        </div>

        {/* Repeating Linear Gradient LED Grid Mask - dynamically matches active theme background */}
        <div
          className="absolute inset-0 pointer-events-none z-30"
          style={{
            background: `repeating-linear-gradient(
              to bottom,
              transparent 0px,
              transparent 6px,
              var(--bg-app, #050508) 6px,
              var(--bg-app, #050508) 8px
            )`,
          }}
        />

        {/* Overload Clip Indicator Bulb */}
        <div
          ref={clipRef}
          className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-red-600 border border-red-400 opacity-20 pointer-events-none z-40 transition-opacity duration-200"
          style={{
            boxShadow: '0 0 8px rgba(239, 68, 68, 0.95)',
          }}
        />

        {/* Label - overlaid at top, above grid mask so it stays readable during playback */}
        <span className="absolute top-2 left-0 right-0 text-center text-[7px] font-bold tracking-[0.2em] uppercase text-white/70 z-50 pointer-events-none font-mono [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
          {label}
        </span>
      </div>
    </div>
  );
};

export function BandMeterWidget({ isVisible = true }: { isVisible?: boolean }) {
  // Level refs (3 per column)
  const bassFastRef = useRef<HTMLDivElement>(null);
  const bassMidRef = useRef<HTMLDivElement>(null);
  const bassSlowRef = useRef<HTMLDivElement>(null);

  const midFastRef = useRef<HTMLDivElement>(null);
  const midMidRef = useRef<HTMLDivElement>(null);
  const midSlowRef = useRef<HTMLDivElement>(null);

  const highFastRef = useRef<HTMLDivElement>(null);
  const highMidRef = useRef<HTMLDivElement>(null);
  const highSlowRef = useRef<HTMLDivElement>(null);

  const energyFastRef = useRef<HTMLDivElement>(null);
  const energyMidRef = useRef<HTMLDivElement>(null);
  const energySlowRef = useRef<HTMLDivElement>(null);

  // Peak refs
  const bassPeakRef = useRef<HTMLDivElement>(null);
  const midPeakRef = useRef<HTMLDivElement>(null);
  const highPeakRef = useRef<HTMLDivElement>(null);
  const energyPeakRef = useRef<HTMLDivElement>(null);

  // Clip refs
  const bassClipRef = useRef<HTMLDivElement>(null);
  const midClipRef = useRef<HTMLDivElement>(null);
  const highClipRef = useRef<HTMLDivElement>(null);
  const energyClipRef = useRef<HTMLDivElement>(null);

  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    let lastBass = -1,
      lastMid = -1,
      lastHigh = -1,
      lastEnergy = -1;
    let silentFrames = 0;

    // Layer values
    let bassFast = 0,
      bassMid = 0,
      bassSlow = 0;
    let midFast = 0,
      midMid = 0,
      midSlow = 0;
    let highFast = 0,
      highMid = 0,
      highSlow = 0;
    let energyFast = 0,
      energyMid = 0,
      energySlow = 0;

    // Peak states
    let bassPeak = 0,
      midPeak = 0,
      highPeak = 0,
      energyPeak = 0;
    let bassPeakTime = 0,
      midPeakTime = 0,
      highPeakTime = 0,
      energyPeakTime = 0;

    // Clip states
    let bassClipTime = 0,
      midClipTime = 0,
      highClipTime = 0,
      energyClipTime = 0;
    let bassClipOpacity = 0.2,
      midClipOpacity = 0.2,
      highClipOpacity = 0.2,
      energyClipOpacity = 0.2;

    const updateMeters = () => {
      // Schedule next frame
      animationRef.current = requestAnimationFrame(updateMeters);

      const { bass, mid, high, energy, audioContext } = audioStore.getState();

      // If AudioContext isn't running, we don't need to spin as hard
      if (audioContext?.state !== 'running' && silentFrames > 5) {
        return;
      }

      if (bass === 0 && mid === 0 && high === 0 && energy === 0) {
        silentFrames++;
      } else {
        silentFrames = 0;
      }

      const now = performance.now();

      // Helper function to update active bar layers, peak-hold line, and clipping bulb
      const processMeter = (
        currentVal: number,
        lastVal: number,
        fastRef: React.RefObject<HTMLDivElement | null>,
        midRef: React.RefObject<HTMLDivElement | null>,
        slowRef: React.RefObject<HTMLDivElement | null>,
        peakRef: React.RefObject<HTMLDivElement | null>,
        clipRef: React.RefObject<HTMLDivElement | null>,
        // Layer states
        fastVal: number,
        midVal: number,
        slowVal: number,
        // Peak and clip states
        peakVal: number,
        peakTime: number,
        clipTime: number,
        clipOpacity: number,
      ) => {
        // 1. Process 3 layered dynamics
        const nextFast = fastVal + (currentVal - fastVal) * 0.35;
        const nextMid = midVal + (currentVal - midVal) * 0.12;
        const nextSlow = slowVal + (currentVal - slowVal) * 0.04;

        // 2. Drive DOM updates (translateY is masked by CSS repeating grid)
        if (Math.abs(nextFast - fastVal) > 0.002 && fastRef.current) {
          fastRef.current.style.transform = `translateY(${(1 - nextFast) * 100}%)`;
        }
        if (Math.abs(nextMid - midVal) > 0.002 && midRef.current) {
          midRef.current.style.transform = `translateY(${(1 - nextMid) * 100}%)`;
        }
        if (Math.abs(nextSlow - slowVal) > 0.002 && slowRef.current) {
          slowRef.current.style.transform = `translateY(${(1 - nextSlow) * 100}%)`;
        }

        // 3. Peak-Hold logic
        let nextPeakVal = peakVal;
        let nextPeakTime = peakTime;

        if (currentVal >= peakVal) {
          nextPeakVal = currentVal;
          nextPeakTime = now;
        } else {
          if (now - peakTime > 1000) {
            nextPeakVal = Math.max(0, peakVal - 0.015);
          }
        }

        if (peakRef.current) {
          peakRef.current.style.transform = `translateY(${(1 - nextPeakVal) * 100}%)`;
        }

        // 4. Overload bulb clipping
        let nextClipTime = clipTime;
        let nextClipOpacity = clipOpacity;

        if (currentVal >= 0.98) {
          nextClipOpacity = 1.0;
          nextClipTime = now;
        } else {
          if (now - clipTime > 500) {
            nextClipOpacity = Math.max(0.2, clipOpacity - 0.08);
          }
        }

        if (clipRef.current) {
          clipRef.current.style.opacity = nextClipOpacity.toString();
        }

        return {
          newLastVal: currentVal,
          newFast: nextFast,
          newMid: nextMid,
          newSlow: nextSlow,
          newPeakVal: nextPeakVal,
          newPeakTime: nextPeakTime,
          newClipTime: nextClipTime,
          newClipOpacity: nextClipOpacity,
        };
      };

      // Bass
      const rBass = processMeter(
        bass,
        lastBass,
        bassFastRef,
        bassMidRef,
        bassSlowRef,
        bassPeakRef,
        bassClipRef,
        bassFast,
        bassMid,
        bassSlow,
        bassPeak,
        bassPeakTime,
        bassClipTime,
        bassClipOpacity,
      );
      lastBass = rBass.newLastVal;
      bassFast = rBass.newFast;
      bassMid = rBass.newMid;
      bassSlow = rBass.newSlow;
      bassPeak = rBass.newPeakVal;
      bassPeakTime = rBass.newPeakTime;
      bassClipTime = rBass.newClipTime;
      bassClipOpacity = rBass.newClipOpacity;

      // Mid
      const rMid = processMeter(
        mid,
        lastMid,
        midFastRef,
        midMidRef,
        midSlowRef,
        midPeakRef,
        midClipRef,
        midFast,
        midMid,
        midSlow,
        midPeak,
        midPeakTime,
        midClipTime,
        midClipOpacity,
      );
      lastMid = rMid.newLastVal;
      midFast = rMid.newFast;
      midMid = rMid.newMid;
      midSlow = rMid.newSlow;
      midPeak = rMid.newPeakVal;
      midPeakTime = rMid.newPeakTime;
      midClipTime = rMid.newClipTime;
      midClipOpacity = rMid.newClipOpacity;

      // High
      const rHigh = processMeter(
        high,
        lastHigh,
        highFastRef,
        highMidRef,
        highSlowRef,
        highPeakRef,
        highClipRef,
        highFast,
        highMid,
        highSlow,
        highPeak,
        highPeakTime,
        highClipTime,
        highClipOpacity,
      );
      lastHigh = rHigh.newLastVal;
      highFast = rHigh.newFast;
      highMid = rHigh.newMid;
      highSlow = rHigh.newSlow;
      highPeak = rHigh.newPeakVal;
      highPeakTime = rHigh.newPeakTime;
      highClipTime = rHigh.newClipTime;
      highClipOpacity = rHigh.newClipOpacity;

      // Energy
      const rEnergy = processMeter(
        energy,
        lastEnergy,
        energyFastRef,
        energyMidRef,
        energySlowRef,
        energyPeakRef,
        energyClipRef,
        energyFast,
        energyMid,
        energySlow,
        energyPeak,
        energyPeakTime,
        energyClipTime,
        energyClipOpacity,
      );
      lastEnergy = rEnergy.newLastVal;
      energyFast = rEnergy.newFast;
      energyMid = rEnergy.newMid;
      energySlow = rEnergy.newSlow;
      energyPeak = rEnergy.newPeakVal;
      energyPeakTime = rEnergy.newPeakTime;
      energyClipTime = rEnergy.newClipTime;
      energyClipOpacity = rEnergy.newClipOpacity;
    };

    animationRef.current = requestAnimationFrame(updateMeters);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isVisible]);

  return (
    <div className="flex items-stretch gap-2 w-full select-none">
      {/* Mathematically Calibrated dB Scale Column */}
      <div className="relative w-5 h-40 text-[7px] font-semibold text-gray-500 font-mono flex-shrink-0 border-r border-white/5 pr-1">
        <div className="absolute top-[0%] right-1.5 text-red-500/80">0</div>
        <div className="absolute top-[29.3%] right-1.5">-3</div>
        <div className="absolute top-[50%] right-1.5">-6</div>
        <div className="absolute top-[75%] right-1.5">-12</div>
        <div className="absolute top-[94%] right-1.5">-24</div>
        <div className="absolute top-[98.5%] right-1.5">-48</div>
      </div>

      <LedMeterButton
        fastRef={bassFastRef}
        midRef={bassMidRef}
        slowRef={bassSlowRef}
        peakRef={bassPeakRef}
        clipRef={bassClipRef}
        label="Bass"
      />
      <LedMeterButton
        fastRef={midFastRef}
        midRef={midMidRef}
        slowRef={midSlowRef}
        peakRef={midPeakRef}
        clipRef={midClipRef}
        label="Mid"
      />
      <LedMeterButton
        fastRef={highFastRef}
        midRef={highMidRef}
        slowRef={highSlowRef}
        peakRef={highPeakRef}
        clipRef={highClipRef}
        label="High"
      />

      {/* Vertical Divider */}
      <div
        className="w-px mx-0.5 self-stretch rounded-full"
        style={{
          background: `linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.08) 50%, transparent 100%)`,
        }}
      />

      <LedMeterButton
        fastRef={energyFastRef}
        midRef={energyMidRef}
        slowRef={energySlowRef}
        peakRef={energyPeakRef}
        clipRef={energyClipRef}
        label="Engy"
      />
    </div>
  );
}
