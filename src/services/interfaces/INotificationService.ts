import * as vscode from "vscode";

/**
 * Priority levels for notifications
 */
export enum NotificationPriority {
  LOW = "low",
  NORMAL = "normal",
  HIGH = "high",
  URGENT = "urgent",
}

/**
 * Notification persistence options
 */
export enum NotificationPersistence {
  TRANSIENT = "transient", // Default VS Code behavior
  STICKY = "sticky", // Won't auto-dismiss
  UNTIL_DISMISSED = "until-dismissed", // Requires explicit dismissal
  SESSION = "session", // Persists for current session
}

/**
 * Notification history entry
 */
export interface NotificationHistoryItem {
  id: string;
  message: string;
  type: "info" | "warning" | "error" | "progress";
  timestamp: Date;
  priority: NotificationPriority;
  dismissed?: boolean;
  dismissedAt?: Date;
  actions?: string[];
  actionSelected?: string;
}

/**
 * Progress notification options
 */
export interface ProgressOptions {
  location?: vscode.ProgressLocation;
  title?: string;
  cancellable?: boolean;
  initialValue?: number; // 0-100
  totalSteps?: number; // For step-based progress
}

/**
 * Notification callback type
 */
export type NotificationCallback = (action?: string) => void | Promise<void>;

/**
 * Interface for notification service
 */
export interface INotificationService extends vscode.Disposable {
  /**
   * Shows an information message
   * @param message Message to display
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  info(
    message: string,
    options?: {
      modal?: boolean;
      detail?: string;
      priority?: NotificationPriority;
      persistence?: NotificationPersistence;
      trackDismissal?: boolean;
      useMarkdown?: boolean;
    },
    ...actions: string[]
  ): Promise<string | undefined>;

  /**
   * Shows a warning message
   * @param message Message to display
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  warn(
    message: string,
    options?: {
      modal?: boolean;
      detail?: string;
      priority?: NotificationPriority;
      persistence?: NotificationPersistence;
      trackDismissal?: boolean;
      useMarkdown?: boolean;
    },
    ...actions: string[]
  ): Promise<string | undefined>;

  /**
   * Shows an error message
   * @param message Message to display
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  error(
    message: string,
    options?: {
      modal?: boolean;
      detail?: string;
      priority?: NotificationPriority;
      persistence?: NotificationPersistence;
      trackDismissal?: boolean;
      useMarkdown?: boolean;
    },
    ...actions: string[]
  ): Promise<string | undefined>;

  /**
   * Shows a notification with callback actions
   * @param message Message to display
   * @param type Type of notification
   * @param callback Callback to execute when action is selected
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  showWithCallback(
    message: string,
    type: "info" | "warning" | "error",
    callback: NotificationCallback,
    options?: {
      modal?: boolean;
      detail?: string;
      priority?: NotificationPriority;
      persistence?: NotificationPersistence;
      trackDismissal?: boolean;
      useMarkdown?: boolean;
    },
    ...actions: string[]
  ): Promise<string | undefined>;

  /**
   * Shows a progress notification for a long-running operation
   * @param title Title for the progress notification
   * @param task The task function that receives a progress object
   * @param options Additional options for the progress display
   */
  withProgress<T>(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken
    ) => Thenable<T>,
    options?: ProgressOptions
  ): Thenable<T>;

  /**
   * Get notification history
   * @param limit Maximum number of items to return (0 for all)
   * @param includeAll Whether to include all notifications or only important ones
   * @returns Array of notification history items
   */
  getHistory(limit?: number, includeAll?: boolean): NotificationHistoryItem[];

  /**
   * Get notification dismissal statistics
   * @returns Object with dismissal stats
   */
  getDismissalStats(): {
    total: number;
    dismissed: number;
    actioned: number;
    dismissalRate: number;
  };

  /**
   * Clear notification history
   */
  clearHistory(): void;

  /**
   * Set throttling duration for notifications
   * @param durationMs Duration in milliseconds
   */
  setThrottleDuration(durationMs: number): void;

  /**
   * Enable or disable notification grouping
   * @param enabled Whether to enable grouping
   */
  enableGrouping(enabled: boolean): void;
}
