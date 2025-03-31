import * as vscode from "vscode";
import {
  INotificationService,
  NotificationLevel,
  NotificationOptions,
  NotificationRecord,
} from "./interfaces/INotificationService";
import { ILogService } from "./interfaces/ILogService";

/**
 * Default implementation of the NotificationService
 * Handles displaying notifications with throttling, grouping, and history tracking
 */
export class NotificationService implements INotificationService {
  private readonly logService?: ILogService;
  private notificationHistory: NotificationRecord[] = [];
  private maxHistorySize: number = 100;

  // Throttling data
  private throttleMap = new Map<
    string,
    {
      lastShown: number;
      count: number;
      timeoutHandle?: NodeJS.Timeout;
    }
  >();

  // Notification grouping data
  private groupedNotifications = new Map<
    string,
    {
      messages: string[];
      level: NotificationLevel;
      groupTimeoutHandle?: NodeJS.Timeout;
    }
  >();

  /**
   * Creates a new NotificationService
   * @param logService Optional log service for logging notification events
   */
  constructor(logService?: ILogService) {
    this.logService = logService;

    if (this.logService) {
      this.logService.info("NotificationService initialized");
    }
  }

  /**
   * Shows an information notification
   * @param message The notification message
   * @param options Additional notification options
   * @returns Promise that resolves to the selected item or undefined
   */
  public async info(
    message: string,
    options?: NotificationOptions
  ): Promise<string | undefined> {
    if (this.logService) {
      this.logService.info(`Notification (info): ${message}`);
    }

    // Check throttling
    if (this.shouldThrottle("info", message, options)) {
      return undefined;
    }

    // Check if this should be added to a group
    if (this.shouldGroup(message, "info", options)) {
      return undefined;
    }

    // Track in history
    this.addToHistory({
      message,
      level: "info",
      timestamp: new Date(),
      options,
    });

    // Show the notification
    const items = options?.actions || [];
    const result = await vscode.window.showInformationMessage(
      message,
      { modal: options?.modal || false },
      ...items
    );

    return result;
  }

  /**
   * Shows a warning notification
   * @param message The notification message
   * @param options Additional notification options
   * @returns Promise that resolves to the selected item or undefined
   */
  public async warning(
    message: string,
    options?: NotificationOptions
  ): Promise<string | undefined> {
    if (this.logService) {
      this.logService.warn(`Notification (warning): ${message}`);
    }

    // Check throttling
    if (this.shouldThrottle("warning", message, options)) {
      return undefined;
    }

    // Check if this should be added to a group
    if (this.shouldGroup(message, "warning", options)) {
      return undefined;
    }

    // Track in history
    this.addToHistory({
      message,
      level: "warning",
      timestamp: new Date(),
      options,
    });

    // Show the notification
    const items = options?.actions || [];
    const result = await vscode.window.showWarningMessage(
      message,
      { modal: options?.modal || false },
      ...items
    );

    return result;
  }

  /**
   * Shows an error notification
   * @param message The notification message
   * @param options Additional notification options
   * @returns Promise that resolves to the selected item or undefined
   */
  public async error(
    message: string,
    options?: NotificationOptions
  ): Promise<string | undefined> {
    if (this.logService) {
      this.logService.error(`Notification (error): ${message}`);
    }

    // Check throttling
    if (this.shouldThrottle("error", message, options)) {
      return undefined;
    }

    // Check if this should be added to a group
    if (this.shouldGroup(message, "error", options)) {
      return undefined;
    }

    // Track in history
    this.addToHistory({
      message,
      level: "error",
      timestamp: new Date(),
      options,
    });

    // Show the notification
    const items = options?.actions || [];
    const result = await vscode.window.showErrorMessage(
      message,
      { modal: options?.modal || false },
      ...items
    );

    return result;
  }

  /**
   * Shows a notification with a progress indicator for long-running operations
   * @param title Title for the progress operation
   * @param task Function that performs the long-running task
   * @param options Additional notification options
   * @returns Promise that resolves when the task completes
   */
  public async withProgress<T>(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>
    ) => Thenable<T>,
    options?: NotificationOptions
  ): Promise<T> {
    if (this.logService) {
      this.logService.info(`Progress notification: ${title}`);
    }

    // Track in history
    this.addToHistory({
      message: title,
      level: "info",
      timestamp: new Date(),
      isProgress: true,
      options,
    });

    const progressOptions: vscode.ProgressOptions = {
      location:
        options?.progressLocation || vscode.ProgressLocation.Notification,
      title,
      cancellable: options?.cancellable || false,
    };

    return vscode.window.withProgress(progressOptions, task);
  }

  /**
   * Shows a notification that requires user input
   * @param message The message to show
   * @param options Additional options for the input
   * @returns Promise that resolves to the user input or undefined if canceled
   */
  public async showInputRequest(
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
  ): Promise<string | undefined> {
    if (this.logService) {
      this.logService.info(`Input request: ${message}`);
    }

    // Track in history
    this.addToHistory({
      message,
      level: "info",
      timestamp: new Date(),
      isInput: true,
    });

    return vscode.window.showInputBox({
      placeHolder: options?.placeHolder,
      prompt: options?.prompt || message,
      value: options?.value,
      password: options?.password,
      validateInput: options?.validateInput,
    });
  }

  /**
   * Gets the notification history
   * @param limit Optional limit on the number of history items to return
   * @returns Array of notification history records
   */
  public getHistory(limit?: number): NotificationRecord[] {
    const historyToShow = limit
      ? this.notificationHistory.slice(-limit)
      : this.notificationHistory;
    return [...historyToShow];
  }

  /**
   * Clears the notification history
   */
  public clearHistory(): void {
    this.notificationHistory = [];

    if (this.logService) {
      this.logService.info("Notification history cleared");
    }
  }

  /**
   * Sets the maximum number of notifications to keep in history
   * @param size The new maximum history size
   */
  public setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;

    // Trim history if needed
    if (this.notificationHistory.length > this.maxHistorySize) {
      this.notificationHistory = this.notificationHistory.slice(
        -this.maxHistorySize
      );
    }

    if (this.logService) {
      this.logService.info(`Max notification history size set to ${size}`);
    }
  }

  /**
   * Shows a grouped notification for multiple similar notifications
   * @param groupKey The key identifying this notification group
   */
  private async showGroupedNotification(groupKey: string): Promise<void> {
    const groupData = this.groupedNotifications.get(groupKey);
    if (!groupData) {
      return;
    }

    // Clear the timeout if it exists
    if (groupData.groupTimeoutHandle) {
      clearTimeout(groupData.groupTimeoutHandle);
    }

    // Don't show empty groups
    if (groupData.messages.length === 0) {
      this.groupedNotifications.delete(groupKey);
      return;
    }

    // Create a grouped message
    let message = "";

    if (groupData.messages.length === 1) {
      message = groupData.messages[0];
    } else {
      message = `${groupData.messages.length} notifications: ${
        groupData.messages[0]
      } ${
        groupData.messages.length > 1
          ? `(+${groupData.messages.length - 1} more)`
          : ""
      }`;
    }

    // Show according to level
    switch (groupData.level) {
      case "info":
        await vscode.window.showInformationMessage(message);
        break;
      case "warning":
        await vscode.window.showWarningMessage(message);
        break;
      case "error":
        await vscode.window.showErrorMessage(message);
        break;
    }

    // Add to history as a grouped notification
    this.addToHistory({
      message,
      level: groupData.level,
      timestamp: new Date(),
      groupSize: groupData.messages.length,
      isGrouped: true,
    });

    // Clear the group
    this.groupedNotifications.delete(groupKey);
  }

  /**
   * Determines if a notification should be added to a group
   * @param message The notification message
   * @param level The notification level
   * @param options Notification options
   * @returns True if the notification was grouped (and shouldn't be shown individually)
   */
  private shouldGroup(
    message: string,
    level: NotificationLevel,
    options?: NotificationOptions
  ): boolean {
    // If grouping is disabled or this is a modal, don't group
    if (options?.groupKey === false || options?.modal) {
      return false;
    }

    // Get or create the group key
    const groupKey = options?.groupKey || level;

    // If we have an existing group
    if (this.groupedNotifications.has(groupKey)) {
      const groupData = this.groupedNotifications.get(groupKey)!;

      // Add this message to the group
      groupData.messages.push(message);

      // Use the highest severity level in the group
      if (level === "error") {
        groupData.level = "error";
      } else if (level === "warning" && groupData.level === "info") {
        groupData.level = "warning";
      }

      // If this is the first addition, set a timeout to show the group
      if (groupData.messages.length === 1) {
        const timeout = options?.groupDelay || 1000;
        groupData.groupTimeoutHandle = setTimeout(() => {
          this.showGroupedNotification(groupKey);
        }, timeout);
      }

      return true;
    }

    // No existing group, so create one if we're supposed to group
    if (options?.grouping !== false) {
      const timeout = options?.groupDelay || 1000;

      this.groupedNotifications.set(groupKey, {
        messages: [message],
        level,
        groupTimeoutHandle: setTimeout(() => {
          this.showGroupedNotification(groupKey);
        }, timeout),
      });

      return true;
    }

    return false;
  }

  /**
   * Determines if a notification should be throttled
   * @param level The notification level
   * @param message The notification message
   * @param options Notification options
   * @returns True if the notification should be throttled (not shown)
   */
  private shouldThrottle(
    level: NotificationLevel,
    message: string,
    options?: NotificationOptions
  ): boolean {
    // If throttling is disabled or this is a modal, don't throttle
    if (options?.throttle === false || options?.modal) {
      return false;
    }

    const throttleKey = options?.throttleKey || message;
    const now = Date.now();
    const throttleData = this.throttleMap.get(throttleKey);
    const throttlePeriod = options?.throttlePeriod || 5000; // Default 5s

    // If we have throttle data and we're within the threshold
    if (throttleData && now - throttleData.lastShown < throttlePeriod) {
      // Increment the counter
      throttleData.count++;

      // If we have a pending timeout, clear it and set a new one
      if (throttleData.timeoutHandle) {
        clearTimeout(throttleData.timeoutHandle);
      }

      // Set a timeout to show a summary message
      throttleData.timeoutHandle = setTimeout(() => {
        if (throttleData.count > 1) {
          // Show a summary message
          const summaryMessage = `${message} (${throttleData.count} occurrences)`;

          switch (level) {
            case "info":
              vscode.window.showInformationMessage(summaryMessage);
              break;
            case "warning":
              vscode.window.showWarningMessage(summaryMessage);
              break;
            case "error":
              vscode.window.showErrorMessage(summaryMessage);
              break;
          }

          // Add to history as a throttled notification
          this.addToHistory({
            message: summaryMessage,
            level,
            timestamp: new Date(),
            isThrottled: true,
            count: throttleData.count,
          });
        }

        // Reset throttle data
        this.throttleMap.delete(throttleKey);
      }, throttlePeriod);

      return true;
    }

    // No throttling needed, but track this notification for future throttling
    this.throttleMap.set(throttleKey, {
      lastShown: now,
      count: 1,
    });

    return false;
  }

  /**
   * Adds a notification record to history
   * @param record The notification record to add
   */
  private addToHistory(record: NotificationRecord): void {
    this.notificationHistory.push(record);

    // Maintain history size
    if (this.notificationHistory.length > this.maxHistorySize) {
      this.notificationHistory.shift();
    }
  }

  /**
   * Returns a promise that resolves after the specified timeout
   * @param ms Milliseconds to wait
   */
  public async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Disposes of any resources used by the service
   */
  public dispose(): void {
    // Clear all timeouts
    for (const data of this.throttleMap.values()) {
      if (data.timeoutHandle) {
        clearTimeout(data.timeoutHandle);
      }
    }

    for (const data of this.groupedNotifications.values()) {
      if (data.groupTimeoutHandle) {
        clearTimeout(data.groupTimeoutHandle);
      }
    }

    this.throttleMap.clear();
    this.groupedNotifications.clear();

    if (this.logService) {
      this.logService.info("NotificationService disposed");
    }
  }
}
