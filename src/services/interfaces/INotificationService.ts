import * as vscode from "vscode";

/**
 * Notification severity levels
 */
export type NotificationLevel = "info" | "warning" | "error";

/**
 * Options for customizing notifications
 */
export interface NotificationOptions {
  /** Actions to show with the notification */
  actions?: string[];

  /** Whether to show the notification as a modal dialog */
  modal?: boolean;

  /** Timeout in ms before the notification is automatically dismissed (0 for no timeout) */
  timeout?: number;

  /** Whether to throttle identical notifications */
  throttle?: boolean;

  /** Custom key to use for throttling instead of the message text */
  throttleKey?: string;

  /** Period in ms during which identical notifications are throttled */
  throttlePeriod?: number;

  /** Whether to enable notification grouping */
  grouping?: boolean;

  /** Custom key to use for grouping instead of the notification level */
  groupKey?: string | false;

  /** Delay in ms before showing grouped notifications */
  groupDelay?: number;

  /** Whether notification can be canceled (for progress notifications) */
  cancellable?: boolean;

  /** Location for progress notifications */
  progressLocation?: vscode.ProgressLocation;
}

/**
 * Record of a shown notification for history tracking
 */
export interface NotificationRecord {
  /** The notification message */
  message: string;

  /** Severity level of the notification */
  level: NotificationLevel;

  /** When the notification was shown */
  timestamp: Date;

  /** Whether this was a throttled notification */
  isThrottled?: boolean;

  /** Whether this was a grouped notification */
  isGrouped?: boolean;

  /** Number of throttled or grouped notifications */
  count?: number;

  /** Size of the notification group */
  groupSize?: number;

  /** Whether this was a progress notification */
  isProgress?: boolean;

  /** Whether this was an input request */
  isInput?: boolean;

  /** Additional options used for the notification */
  options?: NotificationOptions;
}

/**
 * Interface for notification service that manages displaying notifications
 * with advanced features like throttling, grouping, and history tracking
 */
export interface INotificationService extends vscode.Disposable {
  /**
   * Shows an information notification
   * @param message The notification message
   * @param options Additional notification options
   * @returns Promise that resolves to the selected item or undefined
   */
  info(
    message: string,
    options?: NotificationOptions
  ): Promise<string | undefined>;

  /**
   * Shows a warning notification
   * @param message The notification message
   * @param options Additional notification options
   * @returns Promise that resolves to the selected item or undefined
   */
  warning(
    message: string,
    options?: NotificationOptions
  ): Promise<string | undefined>;

  /**
   * Shows an error notification
   * @param message The notification message
   * @param options Additional notification options
   * @returns Promise that resolves to the selected item or undefined
   */
  error(
    message: string,
    options?: NotificationOptions
  ): Promise<string | undefined>;

  /**
   * Shows a notification with a progress indicator for long-running operations
   * @param title Title for the progress operation
   * @param task Function that performs the long-running task
   * @param options Additional notification options
   * @returns Promise that resolves when the task completes
   */
  withProgress<T>(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>
    ) => Thenable<T>,
    options?: NotificationOptions
  ): Promise<T>;

  /**
   * Shows a notification that requires user input
   * @param message The message to show
   * @param options Additional options for the input
   * @returns Promise that resolves to the user input or undefined if canceled
   */
  showInputRequest(
    message: string,
    options?: {
      placeHolder?: string;
      prompt?: string;
      value?: string;
      password?: boolean;
      validateInput?: (
        value: string
      ) => string | undefined | null | Thenable<string | undefined | null>;
    }
  ): Promise<string | undefined>;

  /**
   * Gets the notification history
   * @param limit Optional limit on the number of history items to return
   * @returns Array of notification history records
   */
  getHistory(limit?: number): NotificationRecord[];

  /**
   * Clears the notification history
   */
  clearHistory(): void;

  /**
   * Sets the maximum number of notifications to keep in history
   * @param size The new maximum history size
   */
  setMaxHistorySize(size: number): void;
}
