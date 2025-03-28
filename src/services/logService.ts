import * as vscode from "vscode";
import { ILogService } from "./interfaces/ILogService";
/**
 * Service for centralized logging
 */
export class LogService implements ILogService, vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private isLoggingEnabled: boolean;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Commit Tracker");
    // Initialize logging state from configuration
    const config = vscode.workspace.getConfiguration("commitTracker");
    this.isLoggingEnabled = config.get<boolean>("enableLogging", false);
  }

  /**
   * Logs an informational message
   */
  public info(message: string): void {
    this.log(`INFO: ${message}`);
  }

  /**
   * Logs an error message
   */
  public error(message: string, error?: any): void {
    this.log(`ERROR: ${message}`);
    if (error) {
      this.log(
        typeof error === "string" ? error : JSON.stringify(error, null, 2)
      );
    }
  }

  /**
   * Logs a warning message
   */
  public warn(message: string): void {
    this.log(`WARNING: ${message}`);
  }

  /**
   * Logs a debug message (only in development mode)
   */
  public debug(message: string): void {
    // Only log in debug mode
    if (this.isDebugMode()) {
      this.log(`DEBUG: ${message}`);
    }
  }

  /**
   * Shows or hides the output channel
   * @param preserveFocus If true, the editor focus won't change
   */
  public showOutput(preserveFocus: boolean): void {
    this.outputChannel.show(preserveFocus);
  }

  /**
   * Toggles logging on/off
   * @returns The new logging state (true = enabled)
   */
  public toggleLogging(): boolean {
    this.isLoggingEnabled = !this.isLoggingEnabled;

    // Update configuration
    const config = vscode.workspace.getConfiguration("commitTracker");
    config.update(
      "enableLogging",
      this.isLoggingEnabled,
      vscode.ConfigurationTarget.Global
    );

    return this.isLoggingEnabled;
  }

  private log(message: string): void {
    // Only log if logging is enabled or it's an ERROR message
    if (this.isLoggingEnabled || message.startsWith("ERROR:")) {
      const timestamp = new Date().toISOString();
      this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }
  }

  private isDebugMode(): boolean {
    return vscode.workspace
      .getConfiguration("commitTracker")
      .get("debugMode", false);
  }

  /**
   * Disposes of the output channel
   */
  public dispose(): void {
    this.outputChannel.dispose();
  }
}
