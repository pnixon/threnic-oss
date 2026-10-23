import React, { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import { audioStore } from '@/engine/stores/audioStore';
import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  attachClosestEdge,
  extractClosestEdge,
  Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { AutoResizingText } from '../../../../effects/shared/AutoResizingText';
import { NEEDS_WEBGPU_LABEL } from './effectAvailability';

// Define the audio channels
export type AudioChannel = 'bass' | 'mid' | 'high' | 'energy' | 'none';

interface EffectRowProps {
  id?: string;
  index?: number;
  name: string;
  isEnabled: boolean;
  selectedChannel: AudioChannel;
  currentLevel?: number;
  threshold?: number;
  onToggle: (isEnabled: boolean) => void;
  onSettingsClick: () => void;
  isDraggable?: boolean;
  expanded?: boolean;
  children?: React.ReactNode;
  // Pragmatic DnD support
  dragOverEdge?: Edge | null;
  setDragOverInfo?: (info: { index: number; edge: Edge | null; section: string } | null) => void;
  section?: string;
  isDragging?: boolean;
  onRemove?: () => void;
  isScheduled?: boolean;
  /**
   * When set, this row is PINNED (non-draggable) because the renderer forces its
   * compositing position. The string is the human-readable reason, shown as a
   * tooltip on a pin symbol so the user understands why it breaks the draggable
   * contract. Null/undefined for a freely-draggable row.
   */
  pinnedReason?: string | null;
  /**
   * Optional caveat text (from the effect schema note) surfaced on the row.
   * Shown when the row is collapsed so the user sees the warning without
   * expanding; when expanded the editor body renders the same note, so the
   * row-level copy is hidden to avoid duplication.
   */
  warningNote?: string;
  /**
   * When set, the effect can't render on the current stage (e.g. no WebGPU).
   * The row shows a short {@link NEEDS_WEBGPU_LABEL} badge with this string as
   * its tooltip, and the toggle can't switch it ON (switching off still works,
   * so stale enabled effects can be cleaned up).
   */
  unavailableReason?: string | null;
}

// Background monitor component that fills the row
const BackgroundMonitor = ({
  channel,
  threshold,
}: {
  channel: AudioChannel;
  threshold?: number;
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    if (channel === 'none') {
      if (barRef.current) barRef.current.style.width = '0%';
      return;
    }

    const updateLevel = () => {
      if (barRef.current) {
        const rawLevel = audioStore.getState()[channel];
        const widthPercent = Math.min(Math.max(rawLevel, 0), 1) * 100;
        barRef.current.style.width = `${widthPercent}%`;
      }
      animationRef.current = window.setTimeout(updateLevel, 33);
    };

    animationRef.current = window.setTimeout(updateLevel, 33);

    return () => {
      if (animationRef.current) {
        window.clearTimeout(animationRef.current);
      }
    };
  }, [channel]);

  if (channel === 'none') return null;

  // Gradient colors matching the crucible theme
  const gradientMap: Record<Exclude<AudioChannel, 'none'>, string> = {
    bass: 'linear-gradient(90deg, rgba(239, 68, 68, 0.35) 0%, rgba(239, 68, 68, 0.1) 100%)',
    mid: 'linear-gradient(90deg, rgba(239, 68, 68, 0.35) 0%, rgba(239, 68, 68, 0.1) 100%)',
    high: 'linear-gradient(90deg, rgba(239, 68, 68, 0.35) 0%, rgba(239, 68, 68, 0.1) 100%)',
    energy: 'linear-gradient(90deg, rgba(239, 68, 68, 0.35) 0%, rgba(239, 68, 68, 0.1) 100%)',
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden rounded-xl">
      <div
        ref={barRef}
        className="h-full transition-none"
        style={{ width: '0%', background: gradientMap[channel] }}
      />
      {threshold !== undefined && (
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-white/50 z-10"
          style={{ left: `${Math.min(Math.max(threshold, 0), 1) * 100}%` }}
        />
      )}
    </div>
  );
};

export const EffectRow: React.FC<EffectRowProps> = ({
  id,
  index,
  name,
  isEnabled,
  selectedChannel,
  onToggle,
  onSettingsClick,
  isDraggable = false,
  expanded = false,
  children,
  isDragging: propIsDragging = false,
  dragOverEdge = null,
  threshold,
  setDragOverInfo,
  section = '',
  isScheduled,
  warningNote,
  pinnedReason,
  unavailableReason,
}) => {
  const toggleBlocked = !!unavailableReason && !isEnabled;
  const ref = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    const dragHandleEl = dragHandleRef.current;

    if (!el || !dragHandleEl || !isDraggable || !id || index === undefined) return;

    return combine(
      draggable({
        // The DRAGGABLE element must be the OUTER row (`el`), NOT the inner glass
        // div. The glass div carries `select-none` (user-select: none), and
        // Firefox couples native drag initiation to the selection model: a
        // pointer-down on a `user-select: none` element with non-draggable
        // descendants (the toggle, settings button, monitor bar) frequently
        // makes `dragstart`'s event.target a nested child, so Pragmatic DnD's
        // `draggableRegistry.get(target)` misses and no drag starts — silently,
        // with no console error. Chrome retargets to the nearest draggable
        // ancestor; Firefox does not. Registering on `el` (which has no
        // `select-none`) and passing the glass div as `dragHandle` keeps the
        // grab-handle semantics while letting the drag actually initiate in
        // Firefox. This mirrors the working PseudoLayerRow (Lyrics) pattern,
        // which registers its draggable on the outer element.
        element: el,
        dragHandle: dragHandleEl,
        getInitialData: () => ({ id, index, section, type: 'effect' }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        getData: ({ input }) =>
          attachClosestEdge(
            { id, index, section, type: 'effect' },
            {
              element: el,
              input,
              allowedEdges: ['top', 'bottom'],
            },
          ),
        onDragEnter: ({ self }) => {
          const edge = extractClosestEdge(self.data);
          setDragOverInfo?.({ index, edge, section });
        },
        onDrag({ self }) {
          const edge = extractClosestEdge(self.data);
          setDragOverInfo?.({ index, edge, section });
        },
        onDragLeave: () => setDragOverInfo?.(null),
        onDrop: () => setDragOverInfo?.(null),
      }),
    );
  }, [id, index, isDraggable, section, setDragOverInfo]);

  return (
    <div>
      {/* Drop indicator line */}
      <div
        className={`h-0.5 mx-2 mb-0.5 rounded-full transition-all duration-150 
                    ${
                      dragOverEdge === 'top'
                        ? 'bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-100'
                        : 'opacity-0'
                    }`}
      />

      <div
        ref={ref}
        className={`
                    relative overflow-hidden rounded-xl transition-all duration-200
                    ${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}
                    ${
                      isDragging || propIsDragging
                        ? 'opacity-50 ring-2 ring-red-500/50'
                        : 'opacity-100'
                    }
                `}
      >
        {/* Glass background */}
        <div
          ref={dragHandleRef}
          className={`
                        select-none relative overflow-hidden p-3 rounded-xl border backdrop-blur-md
                        transition-all duration-200 group
                        ${
                          isEnabled
                            ? 'bg-[var(--bg-panel)] border-[var(--border-hover)] hover:border-red-500/30'
                            : 'bg-[var(--bg-hover)] border-[var(--border-subtle)] hover:border-[var(--border-hover)]'
                        }
                        ${isDragging ? 'shadow-xl shadow-red-950/30' : 'shadow-md shadow-black/20'}
                    `}
        >
          {/* Glass sheen effect */}
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-br from-white/[0.06] via-transparent to-transparent rounded-xl" />

          {/* Background Monitor */}
          {isEnabled && <BackgroundMonitor channel={selectedChannel} threshold={threshold} />}

          {/* Content Container */}
          <div className="relative z-10 flex items-center gap-3">
            {/* Toggle Switch */}
            <button
              type="button"
              role="switch"
              aria-checked={isEnabled}
              disabled={toggleBlocked}
              title={toggleBlocked ? (unavailableReason ?? undefined) : undefined}
              onClick={() => onToggle(!isEnabled)}
              className={`
                                relative inline-flex h-5 w-10 items-center rounded-full transition-colors
                                focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:ring-offset-2 focus:ring-offset-transparent
                                ${isEnabled ? '' : 'bg-white/10'}
                                ${toggleBlocked ? 'opacity-40 cursor-not-allowed' : ''}
                            `}
              style={
                isEnabled
                  ? {
                      background: 'linear-gradient(to right, #991b1b, #ef4444)',
                      boxShadow: '0 0 10px rgba(239, 68, 68, 0.3)',
                    }
                  : undefined
              }
            >
              <span
                className={`
                                    inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-md
                                    transition-transform duration-200
                                    ${isEnabled ? 'translate-x-5' : 'translate-x-1'}
                                `}
              />
            </button>

            <div className="flex-1 flex items-center gap-2 min-w-0">
              <AutoResizingText
                className={`
                                  font-medium text-sm transition-colors truncate
                                  ${isEnabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}
                              `}
              >
                {name}
              </AutoResizingText>

              {pinnedReason && (
                <span
                  className="shrink-0 inline-flex items-center justify-center text-[var(--text-muted)] cursor-help"
                  title={pinnedReason}
                  aria-label={`Pinned layer. ${pinnedReason}`}
                  role="img"
                >
                  <LockClosedIcon className="h-3.5 w-3.5" />
                </span>
              )}

              {unavailableReason && (
                <span
                  className="shrink-0 px-1.5 py-0.5 rounded-full border border-[var(--border-subtle)] bg-white/[0.04] text-[8px] leading-none text-[var(--text-muted)] uppercase tracking-wider font-semibold cursor-help"
                  title={unavailableReason}
                >
                  {NEEDS_WEBGPU_LABEL}
                </span>
              )}

              {isScheduled && (
                <div className="px-1.5 py-0.5 rounded-full bg-purple-500/20 border border-purple-500/30 shrink-0">
                  <span className="text-[7px] text-purple-300 font-bold uppercase tracking-widest block leading-none">
                    Scheduled
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onSettingsClick();
              }}
              className={`
                                flex items-center justify-center w-7 h-7 rounded-lg transition-all
                                ${
                                  expanded
                                    ? 'bg-red-500/20 text-red-400'
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                                }
                            `}
              aria-label="Settings"
            >
              <ChevronDownIcon
                className={`h-4 w-4 transition-transform duration-200 ${expanded ? 'rotate-0' : '-rotate-90'}`}
              />
            </button>
          </div>

          {/* Warning note — surfaced on the collapsed row so the caveat is
              visible without expanding. When expanded, the editor body
              renders the same note, so it is hidden here to avoid duplication. */}
          {warningNote && !expanded && (
            <div className="relative z-10 mt-2 flex items-start gap-1.5 rounded-md border border-[var(--border-subtle)] bg-white/[0.04] px-2 py-1.5">
              <span className="shrink-0 text-[10px] leading-[1.4] opacity-80">ⓘ</span>
              <span className="text-[10px] leading-[1.4] text-[var(--text-muted)]">
                {warningNote}
              </span>
            </div>
          )}
        </div>

        {/* Inline Editor Drawer */}
        <div
          className={`
                        overflow-hidden transition-all duration-300 ease-out
                        ${expanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}
                    `}
        >
          {expanded && children && (
            <div
              className="select-auto mt-1 mx-1 p-3 bg-[var(--bg-app)] border border-[var(--border-subtle)] rounded-xl backdrop-blur-lg"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div className="relative">
                {/* Subtle inner glow */}
                <div className="absolute inset-0 rounded-lg bg-gradient-to-b from-red-500/5 to-transparent pointer-events-none" />
                <div className="relative">{children}</div>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Bottom Drop indicator line */}
      <div
        className={`h-0.5 mx-2 mt-0.5 rounded-full transition-all duration-150 
                    ${
                      dragOverEdge === 'bottom'
                        ? 'bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-100'
                        : 'opacity-0'
                    }`}
      />
    </div>
  );
};
