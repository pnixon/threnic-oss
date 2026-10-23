'use client';

import React from 'react';
import { createLogger } from '@/utils/logger';

const logger = createLogger({ enabled: true, prefix: 'Effect' });

interface Props {
  children: React.ReactNode;
  effectName: string;
  onRecover?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

const MAX_RETRIES = 1;
const RETRY_DELAY = 1000;

export class EffectErrorBoundary extends React.Component<Props, State> {
  private retryTimeout: NodeJS.Timeout | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    logger.error(`Effect ${this.props.effectName} crashed:`, error);
    logger.error('Component stack:', errorInfo.componentStack);

    // Attempt auto-recovery if we haven't exceeded retries
    if (this.state.retryCount < MAX_RETRIES) {
      logger.info(`Attempting to recover ${this.props.effectName} in ${RETRY_DELAY}ms...`);
      this.retryTimeout = setTimeout(() => {
        this.attemptRecovery();
      }, RETRY_DELAY);
    } else {
      logger.warn(
        `Effect ${this.props.effectName} failed permanently after ${MAX_RETRIES} retries.`,
      );
    }
  }

  componentWillUnmount() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }
  }

  attemptRecovery = () => {
    if (!this.state.hasError) return;

    logger.info(`Recovering ${this.props.effectName}...`);
    this.setState((prevState) => ({
      hasError: false,
      error: null,
      retryCount: prevState.retryCount + 1,
    }));

    if (this.props.onRecover) {
      this.props.onRecover();
    }
  };

  render() {
    if (this.state.hasError) {
      // Return null so the effect is removed from the scene
      return null;
    }

    return this.props.children;
  }
}
