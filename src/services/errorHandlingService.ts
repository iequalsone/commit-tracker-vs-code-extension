import * as vscode from "vscode";
import { LogService } from "./logService";
import { EventEmitter } from "events";

/**
 * Error types for better categorization and handling
 */
export enum ErrorType {
  CONFIGURATION = "configuration",
  GIT_OPERATION = "git-operation",
  FILESYSTEM = "filesystem",
  REPOSITORY = "repository",
  NETWORK = "network",
  UNKNOWN = "unknown",
}

/**
 * Interface for error details with additional context
 */
export interface ErrorDetails {
  message: string;
  type: ErrorType;
  operation: string;
  originalError?: Error;
  suggestions?: string[];
}

/**
 * Error events emitted by the error handling service
 */
export enum ErrorEvent {
  ERROR_OCCURRED = "error-occurred",
  ERROR_RESOLVED = "error-resolved",
}

/**
 * Centralized service for handling errors across the extension
 */
export class ErrorHandlingService extends EventEmitter {
  private logService: LogService;

  constructor(logService: LogService) {
    super();
    this.logService = logService;
  }

  /**
   * Handle an error with proper logging, events, and optional UI notifications
   *
   * @param error The error object or error message
   * @param operation Description of the operation that failed
   * @param type The type of error for targeted handling
   * @param showNotification Whether to show a UI notification
   * @param suggestions Optional suggestions for resolving the error
   */
  public handleError(
    error: unknown,
    operation: string,
    type: ErrorType = ErrorType.UNKNOWN,
    showNotification: boolean = false,
    suggestions?: string[]
  ): void {
    // Convert to proper error object
    const errorObj = error instanceof Error ? error : new Error(String(error));

    // Create error details
    const errorDetails: ErrorDetails = {
      message: errorObj.message,
      type,
      operation,
      originalError: errorObj,
      suggestions,
    };

    // Log the error
    this.logService.error(
      `[${type}] Error in ${operation}: ${errorObj.message}`
    );

    // Emit error event
    this.emit(ErrorEvent.ERROR_OCCURRED, errorDetails);

    // Show notification if requested
    if (showNotification) {
      let message = `Error: ${errorObj.message}`;

      // Add a standard message based on error type
      switch (type) {
        case ErrorType.CONFIGURATION:
          message = `Configuration error: ${errorObj.message}`;
          break;
        case ErrorType.GIT_OPERATION:
          message = `Git error: ${errorObj.message}`;
          break;
        case ErrorType.FILESYSTEM:
          message = `File system error: ${errorObj.message}`;
          break;
        case ErrorType.REPOSITORY:
          message = `Repository error: ${errorObj.message}`;
          break;
        case ErrorType.NETWORK:
          message = `Network error: ${errorObj.message}`;
          break;
      }

      // Create notification
      const notification = vscode.window.showErrorMessage(
        message,
        ...(suggestions || [])
      );

      // Handle suggestion selections
      if (suggestions && suggestions.length > 0) {
        notification.then((selection) => {
          if (selection) {
            this.emit("suggestion-selected", selection, errorDetails);
          }
        });
      }
    }
  }

  /**
   * Mark an error as resolved
   *
   * @param errorType The type of error that was resolved
   * @param operation The operation where the error occurred
   */
  public resolveError(errorType: ErrorType, operation: string): void {
    this.emit(ErrorEvent.ERROR_RESOLVED, { type: errorType, operation });
    this.logService.info(
      `Resolved previous ${errorType} error in ${operation}`
    );
  }

  /**
   * Disposes resources used by the error handling service
   */
  public dispose(): void {
    this.removeAllListeners();
  }
}
