'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import styles from './AppShell.module.css';
import { MobileNavigation, MobileView } from './MobileNavigation';
import { useMediaQuery } from '@/hooks';
import { usePanels } from '@/contexts';

interface AppShellProps {
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  centerStage: React.ReactNode;
  timeline: React.ReactNode;
  overlays?: React.ReactNode;
  header?: React.ReactNode;
  activeMobileView?: MobileView;
  onActiveMobileViewChange?: (view: MobileView) => void;
  isExporting?: boolean;
  /** Mobile Stage tab: whether the full detailed timeline sheet is expanded.
   *  When false (default), a compact player bar is shown and the canvas takes
   *  the majority of the viewport height. */
  mobileTimelineExpanded?: boolean;
}

export function AppShell({
  leftPanel,
  rightPanel,
  centerStage,
  timeline,
  overlays,
  header,
  activeMobileView: propActiveView,
  onActiveMobileViewChange,
  isExporting = false,
  mobileTimelineExpanded = false,
}: AppShellProps): React.ReactElement {
  const {
    leftCollapsed,
    rightCollapsed,
    bottomCollapsed,
    setLeftCollapsed,
    setRightCollapsed,
    setBottomCollapsed,
    toggleLeft,
    toggleRight,
    toggleBottom,
  } = usePanels();
  const [internalActiveView, setInternalActiveView] = useState<MobileView>('stage');
  const [screenTooSmall, setScreenTooSmall] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setScreenTooSmall(window.innerWidth < 320 || window.innerHeight < 520);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const shellRef = React.useRef<HTMLDivElement>(null);
  const [isResizingRight, setIsResizingRight] = useState(false);

  const handleRightMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizingRight) return;
      e.preventDefault();
      const newWidth = Math.max(200, Math.min(1000, window.innerWidth - e.clientX));
      if (shellRef.current) {
        shellRef.current.style.setProperty('--right-panel-width', `${newWidth}px`);
      }
    },
    [isResizingRight],
  );

  const handleRightMouseUp = useCallback(() => {
    setIsResizingRight(false);
  }, []);

  useEffect(() => {
    if (isResizingRight) {
      document.addEventListener('mousemove', handleRightMouseMove);
      document.addEventListener('mouseup', handleRightMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.classList.add(styles.isResizing);
    } else {
      document.body.style.cursor = '';
      document.body.classList.remove(styles.isResizing);
    }
    return () => {
      document.removeEventListener('mousemove', handleRightMouseMove);
      document.removeEventListener('mouseup', handleRightMouseUp);
      document.body.style.cursor = '';
      document.body.classList.remove(styles.isResizing);
    };
  }, [isResizingRight, handleRightMouseMove, handleRightMouseUp]);

  const [isResizingTimeline, setIsResizingTimeline] = useState(false);

  const handleTimelineMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizingTimeline) return;
      e.preventDefault();
      const newHeight = Math.max(100, Math.min(800, window.innerHeight - e.clientY));
      if (shellRef.current) {
        shellRef.current.style.setProperty('--timeline-height', `${newHeight}px`);
      }
    },
    [isResizingTimeline],
  );

  const handleTimelineMouseUp = useCallback(() => {
    setIsResizingTimeline(false);
  }, []);

  useEffect(() => {
    if (isResizingTimeline) {
      document.addEventListener('mousemove', handleTimelineMouseMove);
      document.addEventListener('mouseup', handleTimelineMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.classList.add(styles.isResizing);
    } else {
      document.body.style.cursor = '';
      document.body.classList.remove(styles.isResizing);
    }
    return () => {
      document.removeEventListener('mousemove', handleTimelineMouseMove);
      document.removeEventListener('mouseup', handleTimelineMouseUp);
      document.body.style.cursor = '';
      document.body.classList.remove(styles.isResizing);
    };
  }, [isResizingTimeline, handleTimelineMouseMove, handleTimelineMouseUp]);

  const activeMobileView = propActiveView ?? internalActiveView;

  const handleActiveViewChange = useCallback(
    (view: MobileView) => {
      if (onActiveMobileViewChange) {
        onActiveMobileViewChange(view);
      } else {
        setInternalActiveView(view);
      }
    },
    [onActiveMobileViewChange],
  );

  const isMobile = useMediaQuery('(max-width: 768px)');
  const isTablet = useMediaQuery('(max-width: 1024px)');
  const isSmallTablet = useMediaQuery('(max-width: 900px)');

  useEffect(() => {
    if (isMobile && !isExporting) {
      const timeout = setTimeout(() => setBottomCollapsed(false), 0);
      return () => clearTimeout(timeout);
    }
  }, [isMobile, isExporting, setBottomCollapsed]);

  // Auto-collapse panels at tablet widths so the center stage gets breathing room,
  // and RE-EXPAND them when the viewport grows back to desktop. This effect owns
  // the collapsed state per breakpoint band so a shrink→grow cycle always restores
  // the panels (previously it only collapsed and never reopened, so panels vanished
  // for good). Uses explicit setters (not toggles) so it is idempotent and cannot
  // accidentally flip a panel the wrong way on a repeated resize.
  //   >1024px  : both panels expanded
  //   ≤1024px  : right collapsed, left expanded
  //   ≤900px   : both collapsed
  useEffect(() => {
    if (isMobile) {
      // Mobile drives panel visibility via activeMobileView (.mobileActive slides
      // the bottom-sheet up); the desktop `collapsed` state must NOT leak in, or a
      // panel that was auto-collapsed at tablet width stays width:0 / hidden and the
      // Playlist/Studio drawer opens empty. Reset both to expanded on mobile entry.
      setLeftCollapsed(false);
      setRightCollapsed(false);
      return;
    }
    if (isSmallTablet) {
      setLeftCollapsed(true);
      setRightCollapsed(true);
    } else if (isTablet) {
      setLeftCollapsed(false);
      setRightCollapsed(true);
    } else {
      setLeftCollapsed(false);
      setRightCollapsed(false);
    }
    // Only react to breakpoint changes, not to manual collapse toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, isTablet, isSmallTablet]);

  function getTimelineAriaLabel(): string {
    if (isMobile) {
      return bottomCollapsed ? 'Expand player' : 'Collapse player';
    }
    return bottomCollapsed ? 'Expand timeline' : 'Collapse timeline';
  }

  function getTimelineChevron(): React.ReactElement {
    if (isMobile) {
      return bottomCollapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
    }
    return bottomCollapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  }

  if (screenTooSmall) {
    return (
      <div className={styles.unsupportedOverlay}>
        <div className={styles.unsupportedCard}>
          <div className={styles.warningHeader}>
            <AlertTriangle className={styles.warningIcon} size={40} />
            <h1 className={styles.warningTitle}>Viewport Unsupported</h1>
          </div>
          <p className={styles.warningText}>
            Threnic requires a larger viewport to support advanced multi-track lyric and keyframe
            timeline editing.
          </p>
          <div className={styles.specsContainer}>
            <div className={styles.specRowHeader}>
              <span>Metric</span>
              <span>Minimum</span>
              <span>Current</span>
            </div>
            <div className={`${styles.specRow} ${window.innerWidth < 320 ? styles.specError : ''}`}>
              <span>Width</span>
              <span>320px</span>
              <span>{window.innerWidth}px</span>
            </div>
            <div
              className={`${styles.specRow} ${window.innerHeight < 520 ? styles.specError : ''}`}
            >
              <span>Height</span>
              <span>520px</span>
              <span>{window.innerHeight}px</span>
            </div>
          </div>
          <div className={styles.warningFooter}>
            Please rotate your device or use a larger screen.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`
        ${styles.shell}
        ${isMobile ? styles.isMobile : ''}
        ${isMobile ? styles[`view-${activeMobileView}`] : ''}
        ${isMobile && activeMobileView === 'stage' && !mobileTimelineExpanded && !isExporting ? styles.mobileStageMini : ''}
        ${isMobile && activeMobileView === 'stage' && mobileTimelineExpanded ? styles.mobileTimelineFull : ''}
        ${bottomCollapsed ? styles.bottomCollapsed : styles.bottomExpanded}
      `}
      ref={shellRef}
    >
      {header && <header className={styles.header}>{header}</header>}

      <div className={styles.main}>
        <div className={styles.centerStage} data-testid="center-stage">
          {centerStage}
        </div>

        {/* Mobile: tap-outside backdrop dismisses an open Playlist/Studio drawer
            back to the Stage view. Sits above the canvas, below the drawer. */}
        {isMobile && (activeMobileView === 'playlist' || activeMobileView === 'studio') && (
          <div
            className={styles.mobileDrawerBackdrop}
            onClick={() => handleActiveViewChange('stage')}
            data-testid="mobile-drawer-backdrop"
            aria-hidden="true"
          />
        )}

        <div className={styles.panelsLayer}>
          <div
            className={`
              ${styles.leftPanel}
              ${leftCollapsed ? styles.collapsed : ''}
              ${isMobile && activeMobileView === 'playlist' ? styles.mobileActive : ''}
            `}
            data-testid="left-panel"
            data-collapsed={leftCollapsed ? 'true' : undefined}
          >
            <button
              className={styles.panelHandle}
              onClick={toggleLeft}
              title={leftCollapsed ? 'Expand Panel' : 'Collapse Panel'}
              data-testid="left-panel-collapse-btn"
            >
              {leftCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
            <div className={styles.panelContent}>{leftPanel}</div>
          </div>

          <div
            className={`
              ${styles.rightPanel}
              ${rightCollapsed ? styles.collapsed : ''}
              ${isMobile && activeMobileView === 'studio' ? styles.mobileActive : ''}
            `}
            data-testid="right-panel"
          >
            {!rightCollapsed && (
              <div
                className={styles.rightResizer}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizingRight(true);
                }}
              />
            )}
            <button
              className={styles.panelHandle}
              onClick={toggleRight}
              title={rightCollapsed ? 'Expand Panel' : 'Collapse Panel'}
              data-testid="right-panel-collapse-btn"
            >
              {rightCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
            <div className={styles.panelContent}>{rightPanel}</div>
          </div>
        </div>

        {overlays && (
          <div
            className={`
                ${styles.overlaysLayer}
                ${!leftCollapsed ? styles.withLeftPanel : ''}
                ${!rightCollapsed ? styles.withRightPanel : ''}
            `}
          >
            {overlays}
          </div>
        )}
      </div>

      <footer
        className={`
          ${styles.timeline}
          ${!isMobile || !isExporting ? 'glass-panel' : ''}
          ${bottomCollapsed ? styles.collapsed : ''}
          ${isMobile && activeMobileView !== 'stage' ? styles.mobileHidden : ''}
          ${isMobile && isExporting ? styles.isExporting : ''}
        `}
        data-testid="timeline-panel"
      >
        {!bottomCollapsed && !isMobile && (
          <div
            className={styles.timelineResizer}
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizingTimeline(true);
            }}
          />
        )}
        <button
          className={styles.timelineHandle}
          onClick={toggleBottom}
          aria-label={getTimelineAriaLabel()}
        >
          {getTimelineChevron()}
        </button>
        <div className={styles.timelineContent}>{timeline}</div>
      </footer>

      {isMobile && (
        <MobileNavigation activeView={activeMobileView} onViewChange={handleActiveViewChange} />
      )}
    </div>
  );
}
