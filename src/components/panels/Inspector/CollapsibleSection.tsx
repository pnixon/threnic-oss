import React from 'react';
import { PanelSection, SubSection } from '../shared';
import styles from './Inspector.module.css';

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  maxHeight?: string | number;
  wrapperClassName?: string;
  wrapperStyle?: React.CSSProperties;
  fitContent?: boolean;
  /** Controlled open state for single-open accordion groups. */
  open?: boolean;
  /** Called when the header is clicked in controlled mode. */
  onToggle?: () => void;
}

/**
 * CollapsibleSection - Wrapper around PanelSection with RightPanel styles
 */
export function CollapsibleSection({
  title,
  icon,
  defaultOpen = false,
  children,
  maxHeight,
  forceOpen = false,
  wrapperClassName,
  wrapperStyle,
  fitContent = false,
  open,
  onToggle,
}: CollapsibleSectionProps & { forceOpen?: boolean }) {
  if (forceOpen) {
    return (
      <div
        className={`${styles.headlessSection} ${wrapperClassName || ''}`.trim()}
        style={wrapperStyle}
      >
        {children}
      </div>
    );
  }

  return (
    <PanelSection
      title={title}
      icon={icon}
      defaultOpen={defaultOpen}
      maxHeight={maxHeight}
      className={`${styles.section} ${wrapperClassName || ''}`.trim()}
      style={wrapperStyle}
      headerClassName={styles.sectionHeader}
      contentClassName={styles.sectionContent}
      fitContent={fitContent}
      open={open}
      onToggle={onToggle}
    >
      {children}
    </PanelSection>
  );
}

/**
 * SubCollapsibleSection - Wrapper around SubSection with RightPanel styles
 */
export function SubCollapsibleSection({
  title,
  children,
  defaultOpen = false,
  open,
  onToggle,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Controlled open state for single-open accordion groups. */
  open?: boolean;
  /** Called when the header is clicked in controlled mode. */
  onToggle?: () => void;
}) {
  return (
    <div className={styles.subSection}>
      <SubSection title={title} defaultOpen={defaultOpen} open={open} onToggle={onToggle}>
        {children}
      </SubSection>
    </div>
  );
}
