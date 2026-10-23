'use client';

import React, { useRef, useLayoutEffect, PropsWithChildren } from 'react';

type AutoResizableElement = HTMLSpanElement &
  HTMLDivElement &
  HTMLLabelElement &
  HTMLHeadingElement &
  HTMLParagraphElement;

interface AutoResizingTextProps {
  className?: string;
  style?: React.CSSProperties;
  minFontSize?: number;
  tagName?: 'span' | 'div' | 'label' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p';
  htmlFor?: string; // For label compatibility
}

/**
 * AutoResizingText - A component that automatically scales down its font size
 * to fit within its container width.
 */
export const AutoResizingText: React.FC<PropsWithChildren<AutoResizingTextProps>> = ({
  children,
  className,
  style,
  minFontSize = 7,
  tagName = 'span',
  htmlFor,
  ...props
}) => {
  const ref = useRef<AutoResizableElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Reset font size to inherit/clean state to measure true overflow
    el.style.fontSize = '';

    // Check if it fits
    if (el.scrollWidth <= el.clientWidth) return;

    // Get starting size explicitly from computed style
    // This handles cases where CSS sets the size
    const computedStyle = window.getComputedStyle(el);
    let currentSize = parseFloat(computedStyle.fontSize);

    // Safety check - if something is weird or 0
    if (!currentSize || isNaN(currentSize)) return;

    // Iteratively reduce size
    while (el.scrollWidth > el.clientWidth && currentSize > minFontSize) {
      currentSize -= 0.5;
      el.style.fontSize = `${currentSize}px`;
    }
  }, [children, minFontSize, className, style]);

  const Tag = tagName;

  return (
    <Tag
      ref={ref}
      className={className}
      htmlFor={htmlFor}
      style={{
        ...style,
        display:
          style?.display || (tagName === 'span' || tagName === 'label' ? undefined : 'block'),
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        // We do typically want text-overflow: ellipsis as a final fallback if even minFontSize fails
        textOverflow: 'ellipsis',
      }}
      {...props}
    >
      {children}
    </Tag>
  );
};
