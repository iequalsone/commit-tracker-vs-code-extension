import * as vscode from "vscode";
import { v4 as uuidv4 } from "uuid";
import {
  INotificationService,
  NotificationCallback,
  NotificationHistoryItem,
  NotificationPersistence,
  NotificationPriority,
  ProgressOptions,
} from "./interfaces/INotificationService";
import { ILogService } from "./interfaces/ILogService";
import { IConfigurationService } from "./interfaces/IConfigurationService";

/**
 * Default implementation of NotificationService
 */
export class NotificationService implements INotificationService {
  private readonly logService?: ILogService;
  private readonly configService?: IConfigurationService;
  private history: NotificationHistoryItem[] = [];
  private throttleMap: Map<string, number> = new Map();
  private groupedNotifications: Map<
    string,
    { count: number; lastShown: number }
  > = new Map();
  private throttleDurationMs: number = 5000; // 5 seconds default
  private groupingEnabled: boolean = true;
  private activeProgressReporters: Map<
    string,
    vscode.Progress<{ message?: string; increment?: number }>
  > = new Map();

  /**
   * Create a new NotificationService
   * @param logService Optional log service for logging
   * @param configService Optional configuration service
   */
  constructor(logService?: ILogService, configService?: IConfigurationService) {
    this.logService = logService;
    this.configService = configService;

    if (this.logService) {
      this.logService.debug("NotificationService initialized");
    }

    // Load configuration if available
    if (this.configService) {
      this.throttleDurationMs = this.configService.get<number>(
        "notificationThrottleDurationMs",
        5000
      );
      this.groupingEnabled = this.configService.get<boolean>(
        "enableNotificationGrouping",
        true
      );
    }
  }

  /**
   * Shows an information message
   * @param message Message to display
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  public async info(
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
  ): Promise<string | undefined> {
    return this.showNotification("info", message, options, ...actions);
  }

  /**
   * Shows a warning message
   * @param message Message to display
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  public async warn(
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
  ): Promise<string | undefined> {
    return this.showNotification("warning", message, options, ...actions);
  }

  /**
   * Shows an error message
   * @param message Message to display
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  public async error(
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
  ): Promise<string | undefined> {
    return this.showNotification("error", message, options, ...actions);
  }

  /**
   * Shows a notification with callback actions
   * @param message Message to display
   * @param type Type of notification
   * @param callback Callback to execute when action is selected
   * @param options Additional options
   * @param actions Available actions
   * @returns Promise resolving to selected action if any
   */
  public async showWithCallback(
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
  ): Promise<string | undefined> {
    const selected = await this.showNotification(
      type,
      message,
      options,
      ...actions
    );

    if (selected) {
      await callback(selected);
    } else if (options?.trackDismissal) {
      await callback(undefined);
    }

    return selected;
  }

  /**
   * Shows a progress notification for a long-running operation
   * @param title Title for the progress notification
   * @param task The task function that receives a progress object
   * @param options Additional options for the progress display
   */
  public withProgress<T>(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken
    ) => Thenable<T>,
    options?: ProgressOptions
  ): Thenable<T> {
    const progressId = `progress-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 7)}`;

    // Add to history before showing
    const historyItem: NotificationHistoryItem = {
      id: progressId,
      message: title,
      type: "progress",
      timestamp: new Date(),
      priority: options?.cancellable
        ? NotificationPriority.HIGH
        : NotificationPriority.NORMAL,
    };

    this.history.push(historyItem);
    this.logService?.debug(`Starting progress notification: ${title}`);

    // Configure progress options
    const progressOptions: vscode.ProgressOptions = {
      location: options?.location ?? vscode.ProgressLocation.Notification,
      title,
      cancellable: options?.cancellable ?? false,
    };

    // Return the progress task
    return vscode.window.withProgress(
      progressOptions,
      async (progress, token) => {
        // Store the progress reporter for potential later use
        this.activeProgressReporters.set(progressId, progress);

        // If initial value is provided, report it
        if (options?.initialValue !== undefined) {
          progress.report({ increment: options.initialValue });
        }

        try {
          // Run the actual task
          const result = await task(progress, token);
          return result;
        } finally {
          // Clean up when task completes
          this.activeProgressReporters.delete(progressId);
        }
      }
    );
  }

  /**
   * Private method to handle all notification display logic
   */
  private async showNotification(
    type: "info" | "warning" | "error",
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
  ): Promise<string | undefined> {
    // Skip notification if throttled or should be grouped
    if (!this.shouldShowNotification(message, options?.priority)) {
      this.logService?.debug(`Notification throttled: ${message}`);
      return undefined;
    }

    // Format the message if markdown is enabled
    const displayMessage = options?.useMarkdown
      ? this.formatMarkdownMessage(message)
      : message;

    // Get potentially grouped message
    const finalMessage = this.groupingEnabled
      ? this.getGroupedMessage(displayMessage)
      : displayMessage;

    // Create a unique ID for this notification
    const notificationId = uuidv4();

    // Add to notification history
    const historyItem: NotificationHistoryItem = {
      id: notificationId,
      message: message, // Store original message
      type: type,
      timestamp: new Date(),
      priority: options?.priority ?? NotificationPriority.NORMAL,
      actions: actions,
    };

    this.history.push(historyItem);

    // Select appropriate VS Code notification method based on type
    let selected: string | undefined;
    try {
      if (type === "info") {
        selected = await vscode.window.showInformationMessage(
          finalMessage,
          { modal: options?.modal, detail: options?.detail },
          ...actions
        );
      } else if (type === "warning") {
        selected = await vscode.window.showWarningMessage(
          finalMessage,
          { modal: options?.modal, detail: options?.detail },
          ...actions
        );
      } else {
        selected = await vscode.window.showErrorMessage(
          finalMessage,
          { modal: options?.modal, detail: options?.detail },
          ...actions
        );
      }
    } catch (error) {
      this.logService?.error("Error showing notification", error);
    }

    // Update history item with result
    const index = this.history.findIndex((item) => item.id === notificationId);
    if (index !== -1) {
      this.history[index].actionSelected = selected;
      if (!selected) {
        this.history[index].dismissed = true;
        this.history[index].dismissedAt = new Date();
      }
    }

    return selected;
  }

  /**
   * Formats a message with markdown support
   * @param message Message to format
   * @returns Formatted message
   */
  private formatMarkdownMessage(message: string): string {
    // Basic markdown support
    return message.replace(/\*\*(.+?)\*\*/g, "$1"); // VS Code notifications don't fully support markdown
  }

  /**
   * Determines if a notification should be shown based on throttling rules
   * @param message The notification message
   * @param priority The notification priority
   * @returns True if notification should be shown
   */
  private shouldShowNotification(
    message: string,
    priority?: NotificationPriority
  ): boolean {
    // High priority notifications always show
    if (
      priority === NotificationPriority.HIGH ||
      priority === NotificationPriority.URGENT
    ) {
      return true;
    }

    const key = this.normalizeMessageForThrottling(message);
    const now = Date.now();
    const lastShown = this.throttleMap.get(key);

    if (lastShown && now - lastShown < this.throttleDurationMs) {
      return false;
    }

    // Update the throttle map
    this.throttleMap.set(key, now);
    return true;
  }

  /**
   * Normalizes a message for throttling comparison
   * @param message The message to normalize
   * @returns Normalized message key
   */
  private normalizeMessageForThrottling(message: string): string {
    // Simple normalization to handle minor variations in messages
    return message
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\w\s]/g, "");
  }

  /**
   * Gets a potentially grouped message
   * @param message The original message
   * @returns The message, potentially modified for grouping
   */
  private getGroupedMessage(message: string): string {
    if (!this.groupingEnabled) {
      return message;
    }

    const key = this.normalizeMessageForThrottling(message);
    const now = Date.now();
    const group = this.groupedNotifications.get(key);

    if (group) {
      // If message seen recently, update count and return grouped message
      if (now - group.lastShown < 60000) {
        // 1 minute grouping window
        group.count += 1;
        group.lastShown = now;
        this.groupedNotifications.set(key, group);
        return `${message} (${group.count}x)`;
      }
    }

    // First time or expired grouping
    this.groupedNotifications.set(key, { count: 1, lastShown: now });
    return message;
  }

  /**
   * Get notification history
   * @param limit Maximum number of items to return (0 for all)
   * @param includeAll Whether to include all notifications or only important ones
   * @returns Array of notification history items
   */
  public getHistory(
    limit: number = 0,
    includeAll: boolean = true
  ): NotificationHistoryItem[] {
    let result = includeAll
      ? [...this.history]
      : this.history.filter(
          (item) =>
            item.priority === NotificationPriority.HIGH ||
            item.priority === NotificationPriority.URGENT
        );

    // Sort by timestamp (newest first)
    result.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Apply limit if specified
    if (limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  /**
   * Get notification dismissal statistics
   * @returns Object with dismissal stats
   */
  public getDismissalStats(): {
    total: number;
    dismissed: number;
    actioned: number;
    dismissalRate: number;
  } {
    const total = this.history.length;
    const dismissed = this.history.filter((item) => item.dismissed).length;
    const actioned = this.history.filter((item) => item.actionSelected).length;
    const dismissalRate = total > 0 ? (dismissed / total) * 100 : 0;

    return {
      total,
      dismissed,
      actioned,
      dismissalRate,
    };
  }

  /**
   * Clear notification history
   */
  public clearHistory(): void {
    this.history = [];
    this.logService?.debug("Notification history cleared");
  }

  /**
   * Set throttling duration for notifications
   * @param durationMs Duration in milliseconds
   */
  public setThrottleDuration(durationMs: number): void {
    this.throttleDurationMs = durationMs;
    this.logService?.debug(
      `Notification throttle duration set to ${durationMs}ms`
    );
  }

  /**
   * Enable or disable notification grouping
   * @param enabled Whether to enable grouping
   */
  public enableGrouping(enabled: boolean): void {
    this.groupingEnabled = enabled;
    this.logService?.debug(
      `Notification grouping ${enabled ? "enabled" : "disabled"}`
    );

    // Clear grouping data if disabled
    if (!enabled) {
      this.groupedNotifications.clear();
    }
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.activeProgressReporters.clear();
    this.throttleMap.clear();
    this.groupedNotifications.clear();
    this.logService?.debug("NotificationService disposed");
  }
}
