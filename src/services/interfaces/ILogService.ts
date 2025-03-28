/**
 * Interface for logging operations
 */
export interface ILogService {
  info(message: string): void;
  error(message: string, error?: unknown): void;
  warn(message: string): void;
  debug(message: string): void;
  showOutput(show?: boolean): void;
}
