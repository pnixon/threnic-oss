import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import { getSetting, saveSetting } from '@/utils/indexedDB';

type HelpTopic =
  | 'general'
  | 'playlist'
  | 'scene'
  | 'title'
  | 'lyrics'
  | 'effects'
  | 'export'
  | 'timeline'
  | 'transitions';

interface HelpContextType {
  isOpen: boolean;
  topic: HelpTopic;
  openHelp: (topic?: HelpTopic) => void;
  closeHelp: () => void;
}

const HelpContext = createContext<HelpContextType | undefined>(undefined);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [topic, setTopic] = useState<HelpTopic>('general');

  // Check if help has been seen on mount
  useEffect(() => {
    const checkHelpSeen = async () => {
      const helpSeen = await getSetting('help_seen', false);
      if (!helpSeen) {
        setIsOpen(true);
      }
    };
    checkHelpSeen();
  }, []);

  const openHelp = (newTopic: HelpTopic = 'general') => {
    setTopic(newTopic);
    setIsOpen(true);
  };

  const closeHelp = async () => {
    setIsOpen(false);
    // Mark as seen when closed
    await saveSetting('help_seen', true);
  };

  return (
    <HelpContext.Provider value={{ isOpen, topic, openHelp, closeHelp }}>
      {children}
    </HelpContext.Provider>
  );
}

export function useHelp() {
  const context = useContext(HelpContext);
  if (context === undefined) {
    throw new Error('useHelp must be used within a HelpProvider');
  }
  return context;
}
