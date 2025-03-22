import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { logError, logInfo } from "./logger";

export async function validateConfig(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("commitTracker");
  const logFilePath = config.get<string>("logFilePath");

  logInfo(
    `Validating configuration - Log file path: ${logFilePath || "not set"}`
  );

  if (!logFilePath) {
    logError("Log file path is not configured");
    vscode.window.showErrorMessage(
      "Commit Tracker: Log file path is not configured. Please set it in the settings."
    );
    return false;
  }

  try {
    // Check if the path exists
    const stats = fs.statSync(logFilePath);
    logInfo(`Log path exists: ${stats.isDirectory()}`);

    if (!stats.isDirectory()) {
      logError(`Log file path is not a directory: ${logFilePath}`);
      vscode.window.showErrorMessage(
        `Commit Tracker: Log file path must be a directory: ${logFilePath}`
      );
      return false;
    }

    // Try to create a test file to ensure we have write permissions
    const testFilePath = path.join(logFilePath, ".test-write-permission");
    fs.writeFileSync(testFilePath, "test", { encoding: "utf8" });
    fs.unlinkSync(testFilePath);
    logInfo(`Write permission check passed for: ${logFilePath}`);

    return true;
  } catch (error) {
    logError(`Failed to validate log file path: ${error}`);
    vscode.window.showErrorMessage(
      `Commit Tracker: Error validating log file path: ${error}`
    );
    return false;
  }
}

export async function selectLogFolder(): Promise<void> {
  const config = vscode.workspace.getConfiguration("commitTracker");
  const folderUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Select Log Folder",
  });

  if (folderUri && folderUri[0]) {
    const selectedPath = folderUri[0].fsPath;
    await config.update(
      "logFilePath",
      selectedPath,
      vscode.ConfigurationTarget.Global
    );
    vscode.window.showInformationMessage(
      `Log file path updated to: ${selectedPath}`
    );
  }
}
