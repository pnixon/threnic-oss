'use client';

import React from 'react';
import { ThemeProvider } from '@/contexts';

export default function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
