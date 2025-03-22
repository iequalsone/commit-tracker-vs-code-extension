import * as vscode from "vscode";

// Create an output channel to log messages
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Initialize the logger with a new output channel
 */
export function initializeLogger(): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Commit Tracker");
  }
}

/**
 * Show the output channel
 * @param preserveFocus Whether to preserve focus (true) or switch to the output channel (false)
 */
export function showOutputChannel(preserveFocus: boolean = true): void {
  if (outputChannel) {
    outputChannel.show(preserveFocus);
  }
}

/**
 * Log an informational message
 * @param message The message to log
 */
export function logInfo(message: string): void {
  if (!outputChannel) {
    initializeLogger();
  }

  if (outputChannel) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[INFO][${timestamp}] ${message}`);
  }
}

/**
 * Log an error message
 * @param message The error message to log
 * @param error Optional error object
 */
export function logError(message: string, error?: any): void {
  if (!outputChannel) {
    initializeLogger();
  }

  if (outputChannel) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[ERROR][${timestamp}] ${message}`);

    if (error) {
      if (error instanceof Error) {
        outputChannel.appendLine(`Error details: ${error.message}`);
        if (error.stack) {
          outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
      } else {
        outputChannel.appendLine(`Error details: ${JSON.stringify(error)}`);
      }
    }
  }
}

/**
 * Dispose of the output channel
 */
export function disposeLogger(): void {
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
  }
}
