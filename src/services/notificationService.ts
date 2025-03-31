import * as vscode from "vscode";
import {
  INotificationService,
  NotificationHistoryItem,
  NotificationPriority,
  NotificationPersistence,
  ProgressOptions,
  NotificationCallback,
} from "./interfaces/INotificationService";
import { ILogService } from "./interfaces/ILogService";

/**
 * Default implementation of NotificationService
 */
export class NotificationService implements INotificationService {
  private readonly logService?: ILogService;
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
   */
  constructor(logService?: ILogService) {
    this.logService = logService;
    if (this.logService) {
      this.logService.info("NotificationService initialized");
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
      try {
        await callback(selected);
      } catch (error) {
        this.logService?.error(`Error in notification callback: ${error}`);
      }
    } else if (options?.trackDismissal) {
      // Handle dismissal
      try {
        await callback(undefined);
      } catch (error) {
        this.logService?.error(`Error in dismissal callback: ${error}`);
      }
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
      .substr(2, 5)}`;

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
      location: options?.location || vscode.ProgressLocation.Notification,
      title,
      cancellable: options?.cancellable || false,
    };

    // Create and show progress
    return vscode.window.withProgress(
      progressOptions,
      async (progress, token) => {
        // Store progress reporter for potential external updates
        this.activeProgressReporters.set(progressId, progress);

        // If initial value is provided
        if (options?.initialValue !== undefined) {
          progress.report({ increment: options.initialValue });
        }

        try {
          // Execute the task
          const result = await task(progress, token);
          this.logService?.debug(`Progress task completed: ${title}`);
          return result;
        } finally {
          // Clean up
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
    // Apply priority-based throttling
    if (!this.shouldShowNotification(message, options?.priority)) {
      this.logService?.debug(`Notification throttled: ${message}`);
      return undefined;
    }

    // Handle notification grouping
    const displayedMessage = this.getGroupedMessage(message);

    // Format message with markdown if needed
    const formattedMessage = options?.useMarkdown
      ? this.formatMarkdownMessage(displayedMessage)
      : displayedMessage;

    // Create a unique ID for this notification
    const id = `${type}-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 5)}`;

    // Add to history before showing
    const historyItem: NotificationHistoryItem = {
      id,
      message,
      type,
      timestamp: new Date(),
      priority: options?.priority || NotificationPriority.NORMAL,
      actions: actions.length > 0 ? [...actions] : undefined,
    };

    this.history.push(historyItem);

    // Log notification
    this.logService?.debug(`Showing ${type} notification: ${message}`);

    // Apply persistence settings
    const isPersistent =
      options?.persistence === NotificationPersistence.STICKY ||
      options?.persistence === NotificationPersistence.UNTIL_DISMISSED;

    // Show the notification
    let selection: string | undefined;

    if (type === "info") {
      selection = await vscode.window.showInformationMessage(
        formattedMessage,
        {
          modal: options?.modal === true,
          detail: options?.detail,
        },
        ...actions
      );
    } else if (type === "warning") {
      selection = await vscode.window.showWarningMessage(
        formattedMessage,
        {
          modal: options?.modal === true,
          detail: options?.detail,
        },
        ...actions
      );
    } else {
      selection = await vscode.window.showErrorMessage(
        formattedMessage,
        {
          modal: options?.modal === true,
          detail: options?.detail,
        },
        ...actions
      );
    }

    // Update history with the action selected or dismissal
    const historyIndex = this.history.findIndex((item) => item.id === id);
    if (historyIndex >= 0) {
      if (selection) {
        this.history[historyIndex].actionSelected = selection;
        this.logService?.debug(`Action selected: ${selection}`);
      } else if (options?.trackDismissal) {
        this.history[historyIndex].dismissed = true;
        this.history[historyIndex].dismissedAt = new Date();
        this.logService?.debug(`Notification dismissed: ${id}`);
      }
    }

    return selection;
  }

  /**
   * Formats a message with markdown support
   * @param message Message to format
   * @returns Formatted message
   */
  private formatMarkdownMessage(message: string): string {
    // VS Code notifications support a subset of markdown
    // We'll ensure only supported elements are used

    // Replace unsupported markdown with supported alternatives
    let formatted = message
      // Replace heading levels (## becomes **bold**)
      .replace(/^(#{1,3})\s+(.+)$/gm, (_, hashes, content) => `**${content}**`)
      // Ensure links are properly formatted
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$1]($2)");

    return formatted;
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
    const now = Date.now();
    const key = this.normalizeMessageForThrottling(message);

    // High priority and urgent notifications bypass throttling
    if (
      priority === NotificationPriority.HIGH ||
      priority === NotificationPriority.URGENT
    ) {
      return true;
    }

    // Check if this notification is currently throttled
    const lastShownTime = this.throttleMap.get(key);
    if (lastShownTime && now - lastShownTime < this.throttleDurationMs) {
      return false;
    }

    // Update the last shown time for this notification
    this.throttleMap.set(key, now);
    return true;
  }

  /**
   * Normalizes a message for throttling comparison
   * @param message The message to normalize
   * @returns Normalized message key
   */
  private normalizeMessageForThrottling(message: string): string {
    // Remove whitespace, make lowercase
    return message.trim().toLowerCase().replace(/\s+/g, " ");
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

    const now = Date.now();
    const key = this.normalizeMessageForThrottling(message);
    const groupInfo = this.groupedNotifications.get(key);

    if (!groupInfo) {
      // First occurrence of this message
      this.groupedNotifications.set(key, { count: 1, lastShown: now });
      return message;
    }

    // Check if we're within the grouping window
    if (now - groupInfo.lastShown < 30000) {
      // 30 seconds grouping window
      // Update the group info
      groupInfo.count++;
      groupInfo.lastShown = now;
      this.groupedNotifications.set(key, groupInfo);

      // Return grouped message
      return `${message} (${groupInfo.count}x)`;
    } else {
      // Reset the counter if outside grouping window
      this.groupedNotifications.set(key, { count: 1, lastShown: now });
      return message;
    }
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
    let filteredHistory = this.history;

    if (!includeAll) {
      // Only include important notifications (high/urgent priority or with actions)
      filteredHistory = this.history.filter(
        (item) =>
          item.priority === NotificationPriority.HIGH ||
          item.priority === NotificationPriority.URGENT ||
          (item.actions && item.actions.length > 0)
      );
    }

    // Sort by most recent first
    const sortedHistory = [...filteredHistory].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );

    // Apply limit if provided
    return limit > 0 ? sortedHistory.slice(0, limit) : sortedHistory;
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
    const trackableNotifications = this.history.filter(
      (item) => item.type !== "progress"
    );
    const total = trackableNotifications.length;
    const dismissed = trackableNotifications.filter(
      (item) => item.dismissed
    ).length;
    const actioned = trackableNotifications.filter(
      (item) => item.actionSelected
    ).length;

    return {
      total,
      dismissed,
      actioned,
      dismissalRate: total > 0 ? dismissed / total : 0,
    };
  }

  /**
   * Clear notification history
   */
  public clearHistory(): void {
    this.history = [];
    this.logService?.info("Notification history cleared");
  }

  /**
   * Set throttling duration for notifications
   * @param durationMs Duration in milliseconds
   */
  public setThrottleDuration(durationMs: number): void {
    this.throttleDurationMs = durationMs;
    this.logService?.info(`Notification throttling set to ${durationMs}ms`);
  }

  /**
   * Enable or disable notification grouping
   * @param enabled Whether to enable grouping
   */
  public enableGrouping(enabled: boolean): void {
    this.groupingEnabled = enabled;
    this.logService?.info(
      `Notification grouping ${enabled ? "enabled" : "disabled"}`
    );

    // Clear grouped notifications when disabling
    if (!enabled) {
      this.groupedNotifications.clear();
    }
  }

  /**
   * Clean up resources when disposing
   */
  public dispose(): void {
    // Clear all maps and collections
    this.throttleMap.clear();
    this.groupedNotifications.clear();
    this.activeProgressReporters.clear();
    this.logService?.debug("NotificationService disposed");
  }
}
