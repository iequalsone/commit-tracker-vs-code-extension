import * as vscode from "vscode";
import { LogService } from "./logService";
import { EventEmitter } from "events";
import { RepositoryEvent } from "../features/repository/repositoryManager";

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
  EXTENSION_NOT_FOUND = "extension-not-found",
  API_INITIALIZATION_FAILED = "api-initialization-failed",
  INITIALIZATION_FAILED = "initialization-failed",
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
   * Enhanced centralized error handling for repository operations
   * Maps different error types to appropriate handlers and notifications
   *
   * @param error The error that occurred
   * @param operation Description of the operation that failed
   * @param errorType The specific type of error for targeted handling
   * @param showNotification Whether to show a notification to the user
   */
  public handleError(
    error: unknown,
    operation: string,
    errorType: ErrorType = ErrorType.UNKNOWN,
    showNotification: boolean = false,
    suggestions: string[] = []
  ): void {
    // Add suggestions based on error type
    switch (errorType) {
      case ErrorType.CONFIGURATION:
        suggestions = ["Open Settings", "Run Setup Wizard"];
        break;
      case ErrorType.GIT_OPERATION:
        suggestions = ["Check Git Installation", "Open Terminal"];
        break;
      case ErrorType.FILESYSTEM:
        suggestions = ["Check Permissions", "Select New Location"];
        break;
      case ErrorType.REPOSITORY:
        suggestions = ["Refresh Status"];
        break;
    }

    // Use the error handling service
    this.handleError(
      error,
      operation,
      errorType,
      showNotification,
      suggestions
    );

    // Always emit legacy events for backward compatibility
    const errorObj = error instanceof Error ? error : new Error(String(error));

    // Emit generic error event
    this.emit(RepositoryEvent.ERROR, errorObj, operation);

    // Also emit specific error event based on type
    switch (errorType) {
      case ErrorType.CONFIGURATION:
        this.emit(RepositoryEvent.ERROR_CONFIGURATION, errorObj);
        break;
      case ErrorType.GIT_OPERATION:
        this.emit(RepositoryEvent.ERROR_GIT_OPERATION, errorObj);
        break;
      case ErrorType.FILESYSTEM:
        this.emit(RepositoryEvent.ERROR_FILESYSTEM, errorObj);
        break;
      case ErrorType.REPOSITORY:
        this.emit(RepositoryEvent.ERROR_REPOSITORY, errorObj);
        break;
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
