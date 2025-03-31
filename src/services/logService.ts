import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ILogService } from "./interfaces/ILogService";

/**
 * Service that manages logging throughout the extension
 */
export class LogService implements ILogService {
  private outputChannel: vscode.OutputChannel;
  private debugMode: boolean;
  private logBuffer: string[] = [];
  private readonly MAX_BUFFER_SIZE: number = 1000; // Limit buffer size to prevent memory issues
  private readonly LOG_ROTATION_SIZE: number = 1024 * 1024; // 1MB
  private fileLoggingEnabled: boolean = false;
  private logFilePath: string | null = null;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Commit Tracker");
    this.debugMode = false; // Default to not showing debug logs

    // Try to get configuration
    try {
      const config = vscode.workspace.getConfiguration("commitTracker");
      this.debugMode = config.get<boolean>("enableDebugLogging", false);
      this.fileLoggingEnabled = config.get<boolean>("enableFileLogging", false);

      if (this.fileLoggingEnabled) {
        const storagePath = vscode.workspace
          .getConfiguration("commitTracker")
          .get<string>("logFilePath");
        if (storagePath) {
          this.logFilePath = path.join(storagePath, "extension.log");
          this.info(`File logging enabled to: ${this.logFilePath}`);
        }
      }
    } catch (error) {
      // If we can't get configuration, log to output channel only
      this.outputChannel.appendLine(
        `[ERROR] Failed to initialize log configuration: ${error}`
      );
    }
  }

  /**
   * Log an informational message
   * @param message The message to log
   * @param data Optional data to include with the log
   */
  public info(message: string, data?: any): void {
    const formattedMessage = this.formatMessage("INFO", message, data);
    this.log(formattedMessage);
  }

  /**
   * Log an error message
   * @param message The error message to log
   * @param error Optional error object to include
   */
  public error(message: string, error?: any): void {
    let formattedMessage = this.formatMessage("ERROR", message);

    // Add error details if available
    if (error) {
      if (error instanceof Error) {
        formattedMessage += `\nError: ${error.message}`;
        if (error.stack) {
          formattedMessage += `\nStack: ${error.stack}`;
        }
      } else {
        formattedMessage += `\nError details: ${JSON.stringify(error)}`;
      }
    }

    this.log(formattedMessage);
  }

  /**
   * Log a warning message
   * @param message The warning message to log
   * @param data Optional data to include with the log
   */
  public warn(message: string, data?: any): void {
    const formattedMessage = this.formatMessage("WARNING", message, data);
    this.log(formattedMessage);
  }

  /**
   * Log a debug message (only shown when debug mode is enabled)
   * @param message The debug message to log
   * @param data Optional data to include with the log
   */
  public debug(message: string, data?: any): void {
    if (!this.debugMode) {
      return;
    }

    const formattedMessage = this.formatMessage("DEBUG", message, data);
    this.log(formattedMessage);
  }

  /**
   * Toggle debug logging on/off
   * @param enabled If provided, explicitly set debug mode; otherwise toggle current state
   * @returns Current state of debug logging after toggle
   */
  public toggleLogging(enabled?: boolean): boolean {
    if (enabled !== undefined) {
      this.debugMode = enabled;
    } else {
      this.debugMode = !this.debugMode;
    }

    this.info(`Debug logging ${this.debugMode ? "enabled" : "disabled"}`);

    // Also update settings if possible
    try {
      vscode.workspace
        .getConfiguration("commitTracker")
        .update(
          "enableDebugLogging",
          this.debugMode,
          vscode.ConfigurationTarget.Global
        );
    } catch (error) {
      this.error(`Failed to update debug logging setting`, error);
    }

    return this.debugMode;
  }

  /**
   * Get the current state of debug logging
   * @returns True if debug logging is enabled
   */
  public isLoggingEnabled(): boolean {
    return this.debugMode;
  }

  /**
   * Show or hide the output panel
   * @param show Whether to show or hide the panel
   */
  public showOutput(show: boolean): void {
    if (show) {
      this.outputChannel.show(true);
    } else {
      this.outputChannel.hide();
    }
  }

  /**
   * Get all logs as text
   * @returns All logs as a string
   */
  public getLogs(): string {
    return this.logBuffer.join("\n");
  }

  /**
   * Clear all logs
   */
  public clearLogs(): void {
    this.outputChannel.clear();
    this.logBuffer = [];
    this.info("Logs cleared");
  }

  /**
   * Format a log message with timestamp and level
   * @param level The log level (INFO, ERROR, etc.)
   * @param message The log message
   * @param data Optional data to include
   */
  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    let formattedMessage = `[${timestamp}] [${level}] ${message}`;

    if (data !== undefined) {
      let dataString = "";
      try {
        dataString =
          typeof data === "object" ? JSON.stringify(data) : String(data);
        formattedMessage += `\nData: ${dataString}`;
      } catch (error) {
        formattedMessage += "\nData: [Unable to stringify data]";
      }
    }

    return formattedMessage;
  }

  /**
   * Write a log message to all configured destinations
   * @param message The formatted message to log
   */
  private log(message: string): void {
    // Always log to output channel
    this.outputChannel.appendLine(message);

    // Store in buffer with rotation
    this.logBuffer.push(message);
    if (this.logBuffer.length > this.MAX_BUFFER_SIZE) {
      this.logBuffer.shift(); // Remove oldest log
    }

    // Log to file if enabled
    if (this.fileLoggingEnabled && this.logFilePath) {
      this.writeToFile(message);
    }
  }

  /**
   * Write a log message to file with rotation
   * @param message The message to write
   */
  private writeToFile(message: string): void {
    try {
      if (!this.logFilePath) return;

      // Create directory if it doesn't exist
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Check if rotation needed
      let shouldRotate = false;
      try {
        if (fs.existsSync(this.logFilePath)) {
          const stats = fs.statSync(this.logFilePath);
          shouldRotate = stats.size >= this.LOG_ROTATION_SIZE;
        }
      } catch (error) {
        // If we can't check, assume no rotation needed
      }

      // Rotate logs if needed
      if (shouldRotate) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotatedPath = `${this.logFilePath}.${timestamp}`;
        fs.renameSync(this.logFilePath, rotatedPath);
      }

      // Append to log file
      fs.appendFileSync(this.logFilePath, message + "\n");
    } catch (error) {
      // Log to output channel only if file logging fails
      this.outputChannel.appendLine(
        `[ERROR] Failed to write to log file: ${error}`
      );
    }
  }

  /**
   * Clean up resources on disposal
   */
  public dispose(): void {
    this.outputChannel.dispose();
  }
}
