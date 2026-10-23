'use client';

import React from 'react';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'BackgroundErrorBoundary' });

export class BackgroundErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { children: React.ReactNode }) {
    if (prevProps.children !== this.props.children) {
      if (this.state.hasError) {
        this.setState({ hasError: false });
      }
    }
  }

  componentDidCatch(error: Error): void {
    logger.warn('Background load failed, falling back to empty:', error);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}
