'use client';

import React, { createContext, useContext } from 'react';

interface EffectEditorContextValue {
  propertyPrefix: string;
  instanceId?: string;
  currentTime?: number;
  targetKeyframeId?: string;
}

const EffectEditorContext = createContext<EffectEditorContextValue | null>(null);

/**
 * Provides common keyframing context (prefix, instanceId, and time) to all fields
 * within an effect editor.
 */
export function EffectEditorProvider({
  children,
  propertyPrefix,
  instanceId,
  currentTime,
  targetKeyframeId,
}: {
  children: React.ReactNode;
  propertyPrefix: string;
  instanceId?: string;
  currentTime?: number;
  targetKeyframeId?: string;
}) {
  return (
    <EffectEditorContext.Provider
      value={{ propertyPrefix, instanceId, currentTime, targetKeyframeId }}
    >
      {children}
    </EffectEditorContext.Provider>
  );
}

/**
 * Hook to consume effect editor context.
 */
export function useEffectEditor() {
  return useContext(EffectEditorContext);
}
