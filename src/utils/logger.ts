export interface LoggerConfig {
  enabled: boolean;
  prefix?: string;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Creates a prefix-aware logger that respects environment settings.
 * debug() logs are only visible in development.
 */
export function createLogger(config: LoggerConfig): Logger {
  const isDev = process.env.NODE_ENV === 'development';
  const prefix = config.prefix ? `[${config.prefix}]` : '[App]';

  return {
    debug(message: string, ...args: unknown[]): void {
      if (isDev && config.enabled) {
        console.log(`${prefix} DEBUG: ${message}`, ...args);
      }
    },
    info(message: string, ...args: unknown[]): void {
      if (config.enabled) {
        console.info(`${prefix} INFO: ${message}`, ...args);
      }
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`${prefix} WARN: ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`${prefix} ERROR: ${message}`, ...args);
    },
  };
}
