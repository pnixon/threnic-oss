import React, { useEffect } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import AudioMonitor from './AudioMonitor';
import styles from './PlaylistBrowser.module.css';
import { usePanels } from '@/contexts';
import { useMediaQuery } from '@/hooks';

interface AudioMonitorSectionProps {
  isMonitorExpanded: boolean;
  setIsMonitorExpanded: (v: boolean) => void;
}

export function AudioMonitorSection({
  isMonitorExpanded,
  setIsMonitorExpanded,
}: AudioMonitorSectionProps) {
  const { leftCollapsed } = usePanels();
  const isVisible = !leftCollapsed && isMonitorExpanded;
  const isSmallScreen = useMediaQuery('(max-width: 1024px)');

  // Auto-collapse monitor on smaller screens to save vertical space
  useEffect(() => {
    if (isSmallScreen) {
      setIsMonitorExpanded(false);
    }
  }, [isSmallScreen, setIsMonitorExpanded]);

  return (
    <div className={`${styles.monitorSection} ${!isMonitorExpanded ? styles.collapsed : ''}`}>
      <div
        className={styles.monitorHeader}
        onClick={() => setIsMonitorExpanded(!isMonitorExpanded)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={14} />
          <span>Audio Monitor</span>
        </div>
        <ChevronDown size={14} className={styles.collapseIcon} />
      </div>
      <div className={styles.monitorContent}>
        <AudioMonitor isVisible={isVisible} />
      </div>
    </div>
  );
}
