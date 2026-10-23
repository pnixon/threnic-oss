'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface PanelContextType {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  setLeftCollapsed: (v: boolean) => void;
  setRightCollapsed: (v: boolean) => void;
  setBottomCollapsed: (v: boolean) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
}

const PanelContext = createContext<PanelContextType | undefined>(undefined);

export function PanelProvider({ children }: { children: ReactNode }) {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  const toggleLeft = useCallback(() => setLeftCollapsed((v) => !v), []);
  const toggleRight = useCallback(() => setRightCollapsed((v) => !v), []);
  const toggleBottom = useCallback(() => setBottomCollapsed((v) => !v), []);

  return (
    <PanelContext.Provider
      value={{
        leftCollapsed,
        rightCollapsed,
        bottomCollapsed,
        setLeftCollapsed,
        setRightCollapsed,
        setBottomCollapsed,
        toggleLeft,
        toggleRight,
        toggleBottom,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanels() {
  const context = useContext(PanelContext);
  if (context === undefined) {
    throw new Error('usePanels must be used within a PanelProvider');
  }
  return context;
}
