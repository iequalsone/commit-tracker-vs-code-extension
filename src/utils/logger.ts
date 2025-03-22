import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel;
let isLoggingEnabled = false; // Default to disabled logging

export function initializeLogger(): void {
  outputChannel = vscode.window.createOutputChannel("Commit Tracker");
}

export function showOutputChannel(preserveFocus: boolean): void {
  outputChannel.show(preserveFocus);
}

export function logInfo(message: string): void {
  if (isLoggingEnabled) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[INFO][${timestamp}] ${message}`);
  }
}

export function logError(message: string): void {
  // We always log errors, even if general logging is disabled
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[ERROR][${timestamp}] ${message}`);
}

export function toggleLogging(): boolean {
  isLoggingEnabled = !isLoggingEnabled;

  // Log the state change (this will only appear if logging is now enabled)
  if (isLoggingEnabled) {
    logInfo("Logging enabled");
  } else {
    // This one last message even though logging is disabled
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[INFO][${timestamp}] Logging disabled`);
  }

  // Also update configuration to persist the setting
  vscode.workspace
    .getConfiguration("commitTracker")
    .update(
      "enableLogging",
      isLoggingEnabled,
      vscode.ConfigurationTarget.Global
    );

  return isLoggingEnabled;
}

export function setLoggingState(enabled: boolean): void {
  isLoggingEnabled = enabled;
  if (isLoggingEnabled) {
    logInfo("Logging initialized and enabled");
  }
}
