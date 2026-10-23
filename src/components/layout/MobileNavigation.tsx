'use client';

import React from 'react';
import { Music, Sliders, MonitorPlay } from 'lucide-react';
import styles from './MobileNavigation.module.css';

export type MobileView = 'stage' | 'playlist' | 'studio' | 'settings';

interface MobileNavigationProps {
  activeView: MobileView;
  onViewChange: (view: MobileView) => void;
}

export function MobileNavigation({
  activeView,
  onViewChange,
}: MobileNavigationProps): React.ReactElement {
  const navItems = [
    { view: 'stage' as const, icon: MonitorPlay, label: 'Stage' },
    { view: 'playlist' as const, icon: Music, label: 'Playlist' },
    { view: 'studio' as const, icon: Sliders, label: 'Studio' },
  ];

  return (
    <nav className={styles.nav}>
      {navItems.map(({ view, icon: Icon, label }) => (
        <button
          key={view}
          className={`${styles.navItem} ${activeView === view ? styles.active : ''}`}
          onClick={() => onViewChange(view)}
          aria-label={label}
          data-testid={`mobile-nav-${view}`}
        >
          <Icon className={styles.icon} />
          <span className={styles.label}>{label}</span>
        </button>
      ))}
    </nav>
  );
}
