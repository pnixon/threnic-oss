/**
 * Minimal, self-contained logger.
 *
 * Copied from the Threnic app (src/utils/logger.ts) so the package carries no
 * `@/utils` dependency. Consumers may inject their own logger where the API
 * allows; this is the default.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Narrow ambient declaration so we can read NODE_ENV without depending on all
// of @types/node. Guarded at runtime by `typeof process !== 'undefined'`.
declare const process: { env?: { NODE_ENV?: string } } | undefined;

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
 * Creates a prefix-aware logger. debug() logs only in development.
 */
export function createLogger(config: LoggerConfig): Logger {
  const isDev =
    typeof process !== 'undefined' && process.env ? process.env.NODE_ENV === 'development' : false;
  const prefix = config.prefix ? `[${config.prefix}]` : '[Lyrics]';

  return {
    debug(message: string, ...args: unknown[]): void {
      if (isDev && config.enabled) console.log(`${prefix} DEBUG: ${message}`, ...args);
    },
    info(message: string, ...args: unknown[]): void {
      if (config.enabled) console.info(`${prefix} INFO: ${message}`, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`${prefix} WARN: ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`${prefix} ERROR: ${message}`, ...args);
    },
  };
}

/** Default logger for general use */
export const logger = createLogger({ enabled: true, prefix: 'Lyrics' });
