import * as vscode from "vscode";

/**
 * Interface for logging services used throughout the extension
 */
export interface ILogService extends vscode.Disposable {
  /**
   * Log an informational message
   * @param message The message to log
   * @param data Optional data to include with the log
   */
  info(message: string, data?: any): void;

  /**
   * Log an error message
   * @param message The error message to log
   * @param error Optional error object to include
   */
  error(message: string, error?: any): void;

  /**
   * Log a warning message
   * @param message The warning message to log
   * @param data Optional data to include with the log
   */
  warn(message: string, data?: any): void;

  /**
   * Log a debug message (only shown when debug mode is enabled)
   * @param message The debug message to log
   * @param data Optional data to include with the log
   */
  debug(message: string, data?: any): void;

  /**
   * Toggle debug logging on/off
   * @param enabled If provided, explicitly set debug mode; otherwise toggle current state
   * @returns Current state of debug logging after toggle
   */
  toggleLogging(enabled?: boolean): boolean;

  /**
   * Get the current state of debug logging
   * @returns True if debug logging is enabled
   */
  isLoggingEnabled(): boolean;

  /**
   * Show or hide the output panel
   * @param show Whether to show or hide the panel
   */
  showOutput(show: boolean): void;

  /**
   * Get all logs as text
   * @returns All logs as a string
   */
  getLogs(): string;

  /**
   * Clear all logs
   */
  clearLogs(): void;
}
