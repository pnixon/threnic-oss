'use client';

import { useEffect } from 'react';
import {
  PlaylistProvider,
  HelpProvider,
  PanelProvider,
  KeyframeSelectionProvider,
} from '@/contexts';
import { AppContent } from '@/components/layout/AppContent';

/**
 * The editor is the whole app: `/` renders it directly.
 */
export default function EditorPage() {
  useEffect(() => {
    // Enables overflow:hidden on html/body for the full-viewport editor layout.
    document.body.classList.add('app-layout');
    document.documentElement.classList.add('app-layout');
    return () => {
      document.body.classList.remove('app-layout');
      document.documentElement.classList.remove('app-layout');
    };
  }, []);

  return (
    <PlaylistProvider>
      <KeyframeSelectionProvider>
        <HelpProvider>
          <PanelProvider>
            <AppContent />
          </PanelProvider>
        </HelpProvider>
      </KeyframeSelectionProvider>
    </PlaylistProvider>
  );
}
