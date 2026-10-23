import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

interface PanelSectionProps {
  /** Section title */
  title: string;
  /** Icon element */
  icon?: React.ReactNode;
  /** Whether section is open by default */
  defaultOpen?: boolean;
  /** Section content */
  children: React.ReactNode;
  /** Maximum height when expanded */
  maxHeight?: string | number;
  /** Additional CSS class for section */
  className?: string;
  /** Additional CSS class for header */
  headerClassName?: string;
  /** Additional CSS class for content */
  contentClassName?: string;
  /** Inline style for section */
  style?: React.CSSProperties;
  /** Whether the section should fit its content height instead of expanding in flex space */
  fitContent?: boolean;
  /**
   * Controlled open state. When provided (together with `onToggle`), the
   * section becomes controlled — the parent owns the open/closed state
   * (used for single-open accordion groups). When omitted, the section
   * manages its own state internally via `defaultOpen`.
   */
  open?: boolean;
  /** Called when the header is clicked in controlled mode. */
  onToggle?: () => void;
}

/**
 * PanelSection - Collapsible section with smooth animations
 */
export function PanelSection({
  title,
  icon,
  defaultOpen = false,
  children,
  maxHeight,
  className = '',
  headerClassName = '',
  contentClassName = '',
  style,
  fitContent = false,
  open,
  onToggle,
}: PanelSectionProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = isControlled ? open : internalOpen;
  const [height, setHeight] = useState<number | undefined>(
    (isControlled ? open : defaultOpen) ? undefined : 0,
  );
  const contentRef = useRef<HTMLDivElement>(null);

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.();
    } else {
      setInternalOpen((v) => !v);
    }
  };

  useEffect(
    function updateHeight() {
      if (!contentRef.current) return;

      if (isOpen) {
        const scrollHeight = contentRef.current.scrollHeight;
        let targetHeight = scrollHeight;

        if (maxHeight) {
          const max = typeof maxHeight === 'number' ? maxHeight : parseInt(maxHeight, 10);
          if (max && !isNaN(max) && scrollHeight > max) {
            targetHeight = max;
          }
        }

        const initialTimeout = setTimeout(() => setHeight(targetHeight), 0);

        const timer = setTimeout(() => {
          setHeight(undefined);
        }, 300);

        return () => {
          clearTimeout(initialTimeout);
          clearTimeout(timer);
        };
      } else {
        const offsetHeight = contentRef.current.offsetHeight;
        const initialTimeout = setTimeout(() => setHeight(offsetHeight), 0);

        const timer = setTimeout(() => {
          setHeight(0);
        }, 10);

        return () => {
          clearTimeout(initialTimeout);
          clearTimeout(timer);
        };
      }
    },
    [isOpen, maxHeight],
  );

  const isFullyOpen = isOpen && height === undefined;
  const isFullyOpenAndFlexing = isFullyOpen && !fitContent;

  return (
    <section
      className={className}
      style={{
        ...style,
        display: 'flex',
        flexDirection: 'column',
        ...(isFullyOpenAndFlexing ? { flex: '1 1 auto', minHeight: 0 } : { flex: '0 0 auto' }),
      }}
    >
      <button
        className={headerClassName}
        onClick={handleToggle}
        type="button"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          padding: '10px 14px',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          cursor: 'pointer',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {icon}
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-primary)',
            }}
          >
            {title}
          </span>
        </div>
        <ChevronDown
          size={14}
          style={{
            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.3s ease',
            color: 'var(--text-muted)',
          }}
        />
      </button>
      <div
        ref={contentRef}
        className={contentClassName}
        style={{
          height: height !== undefined ? `${height}px` : 'auto',
          overflow: 'hidden',
          transition: 'height 0.3s ease',
          display: 'flex',
          flexDirection: 'column',
          ...(isFullyOpenAndFlexing ? { flex: '1 1 auto', minHeight: 0 } : {}),
        }}
      >
        <div
          className="custom-scrollbar"
          style={{
            padding: '12px 14px',
            ...(isFullyOpenAndFlexing
              ? {
                  flex: '1 1 auto',
                  minHeight: 0,
                  overflowY: 'auto',
                }
              : {
                  maxHeight: isOpen ? maxHeight : undefined,
                  overflowY: isOpen && maxHeight ? 'auto' : 'hidden',
                }),
          }}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

interface SubSectionProps {
  /** Subsection title */
  title: string;
  /** Subsection content */
  children: React.ReactNode;
  /** Whether subsection is open by default */
  defaultOpen?: boolean;
  /** Controlled open state for single-open accordion groups. */
  open?: boolean;
  /** Called when the header is clicked in controlled mode. */
  onToggle?: () => void;
}

/**
 * SubSection - Smaller collapsible section for nested content
 */
export function SubSection({
  title,
  children,
  defaultOpen = true,
  open,
  onToggle,
}: SubSectionProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = isControlled ? open : internalOpen;
  const [height, setHeight] = useState<number | undefined>(
    (isControlled ? open : defaultOpen) ? undefined : 0,
  );
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(
    function updateHeight() {
      if (!contentRef.current) return;

      if (isOpen) {
        const scrollHeight = contentRef.current.scrollHeight;
        const initialTimeout = setTimeout(() => setHeight(scrollHeight), 0);
        const timer = setTimeout(() => setHeight(undefined), 300);
        return () => {
          clearTimeout(initialTimeout);
          clearTimeout(timer);
        };
      } else {
        const scrollHeight = contentRef.current.scrollHeight;
        const initialTimeout = setTimeout(() => setHeight(scrollHeight), 0);
        const timer = setTimeout(() => setHeight(0), 10);
        return () => {
          clearTimeout(initialTimeout);
          clearTimeout(timer);
        };
      }
    },
    [isOpen],
  );

  return (
    <div style={{ marginBottom: '2px' }}>
      <button
        onClick={() => {
          if (isControlled) {
            onToggle?.();
          } else {
            setInternalOpen((v) => !v);
          }
        }}
        type="button"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'none',
          border: 'none',
          color: 'var(--text-secondary)',
          padding: '6px 0',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        <span>{title}</span>
        <ChevronDown
          size={12}
          style={{
            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.3s ease',
          }}
        />
      </button>
      <div
        ref={contentRef}
        style={{
          height: height !== undefined ? `${height}px` : 'auto',
          overflow: 'hidden',
          transition: 'height 0.3s ease',
        }}
      >
        <div style={{ paddingBottom: 2 }}>{children}</div>
      </div>
    </div>
  );
}
