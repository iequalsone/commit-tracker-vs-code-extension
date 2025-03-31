import * as vscode from "vscode";

/**
 * Notification action to be shown with notification
 */
export interface NotificationAction {
  /** Text to display on the action button */
  title: string;

  /** Function to call when action is clicked */
  callback: () => Promise<void> | void;

  /** Whether this is the primary action (displayed prominently) */
  isPrimary?: boolean;
}

/**
 * Notification options to control notification behavior
 */
export interface NotificationOptions {
  /** Actions to display with the notification */
  actions?: NotificationAction[];

  /** Duration in milliseconds to show notification (undefined for persistent) */
  duration?: number;

  /** If true, notification requires explicit dismissal */
  modal?: boolean;

  /** Unique ID for tracking/grouping similar notifications */
  id?: string;

  /** Group ID for notification throttling/grouping */
  groupId?: string;

  /** Importance of notification (higher appears more prominently) */
  priority?: "low" | "normal" | "high";

  /** Whether to show the notification again if a similar one was recently shown */
  suppressIfDuplicate?: boolean;
}

/**
 * History entry for notifications
 */
export interface NotificationHistoryEntry {
  /** Type of notification (info, warning, error) */
  type: "info" | "warning" | "error" | "progress";

  /** Message displayed in the notification */
  message: string;

  /** When the notification was shown */
  timestamp: Date;

  /** Unique ID if provided */
  id?: string;

  /** Group ID if provided */
  groupId?: string;

  /** Whether user dismissed the notification */
  dismissed?: boolean;

  /** Whether any actions were taken */
  actionTaken?: boolean;

  /** Which action was taken (if any) */
  actionTitle?: string;
}

/**
 * Interface for notification service
 * Provides abstraction over VS Code's notification system with added features
 */
export interface INotificationService extends vscode.Disposable {
  /**
   * Shows an information message to the user
   * @param message Message to show
   * @param options Notification options
   * @returns Promise that resolves when notification is shown
   */
  info(message: string, options?: NotificationOptions): Promise<void>;

  /**
   * Shows a warning message to the user
   * @param message Warning message to show
   * @param options Notification options
   * @returns Promise that resolves when notification is shown
   */
  warn(message: string, options?: NotificationOptions): Promise<void>;

  /**
   * Shows an error message to the user
   * @param message Error message to show
   * @param options Notification options
   * @returns Promise that resolves when notification is shown
   */
  error(message: string, options?: NotificationOptions): Promise<void>;

  /**
   * Shows a notification with progress
   * @param title Title for the progress notification
   * @param task Function that performs work and reports progress
   * @returns Promise that resolves with the result of the task
   */
  withProgress<T>(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>
    ) => Promise<T>
  ): Promise<T>;

  /**
   * Shows a message requesting user confirmation
   * @param message Message to show
   * @param confirmText Text for confirm button
   * @param cancelText Optional text for cancel button
   * @returns Promise resolving to true if confirmed, false otherwise
   */
  confirm(
    message: string,
    confirmText: string,
    cancelText?: string
  ): Promise<boolean>;

  /**
   * Shows a message with multiple options for user selection
   * @param message Message to show
   * @param items Options for user to select
   * @param options Additional notification options
   * @returns Promise resolving to selected item or undefined if dismissed
   */
  showOptions<T extends string>(
    message: string,
    items: T[],
    options?: NotificationOptions
  ): Promise<T | undefined>;

  /**
   * Shows a notification that remains until explicitly dismissed
   * @param message Message to show
   * @param type Type of notification
   * @param options Additional notification options
   * @returns Function to dismiss the notification
   */
  showPersistent(
    message: string,
    type: "info" | "warning" | "error",
    options?: NotificationOptions
  ): () => void;

  /**
   * Gets notification history
   * @param limit Maximum number of entries to retrieve
   * @returns Array of notification history entries
   */
  getHistory(limit?: number): NotificationHistoryEntry[];

  /**
   * Clears notification history
   */
  clearHistory(): void;

  /**
   * Sets the throttle interval for notifications
   * @param groupId Group ID to throttle
   * @param intervalMs Throttle interval in milliseconds
   */
  setThrottleInterval(groupId: string, intervalMs: number): void;

  /**
   * Enables or disables all notifications
   * @param enabled Whether notifications should be enabled
   */
  setEnabled(enabled: boolean): void;

  /**
   * Gets whether notifications are currently enabled
   * @returns True if notifications are enabled
   */
  isEnabled(): boolean;

  /**
   * Sets the default options for notifications
   * @param options Default options to use
   */
  setDefaultOptions(options: Partial<NotificationOptions>): void;

  /**
   * Shows a notification with a text input field
   * @param message Message to show
   * @param placeholder Placeholder text for input
   * @param defaultValue Default value for input
   * @param options Additional notification options
   * @returns Promise resolving to input value or undefined if dismissed
   */
  prompt(
    message: string,
    placeholder?: string,
    defaultValue?: string,
    options?: NotificationOptions
  ): Promise<string | undefined>;

  /**
   * Creates a notification that can be updated
   * @param initialMessage Initial message to display
   * @param type Type of notification
   * @returns Object with methods to update or dismiss the notification
   */
  createUpdatableNotification(
    initialMessage: string,
    type: "info" | "warning" | "error"
  ): {
    update(message: string): void;
    dismiss(): void;
  };

  /**
   * Dismisses all active notifications
   */
  dismissAll(): void;
}
