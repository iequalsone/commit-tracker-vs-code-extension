import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export async function validateConfig(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('commitTracker');
  const logFilePath = config.get<string>('logFilePath');
  const logFile = config.get<string>('logFile');

  if (!logFilePath || !path.isAbsolute(logFilePath)) {
    const selection = await vscode.window.showErrorMessage(
      'Invalid log file path. Please configure an absolute path for the log file.',
      'Select Log Folder'
    );
    if (selection === 'Select Log Folder') {
      await selectLogFolder();
      return await validateConfig();
    }
    return false;
  }

  if (!logFile || path.isAbsolute(logFile) || logFile.includes('..')) {
    vscode.window.showErrorMessage('Invalid log file name. Please configure a valid log file name.');
    return false;
  }

  try {
    fs.accessSync(logFilePath, fs.constants.W_OK);
  } catch (err) {
    const selection = await vscode.window.showErrorMessage('Log file path is not writable. Please configure a writable path.', 'Select Log Folder');
    if (selection === 'Select Log Folder') {
      await selectLogFolder();
      return await validateConfig();
    }
    return false;
  }

  return true;
}

export async function selectLogFolder(): Promise<void> {
  const config = vscode.workspace.getConfiguration('commitTracker');
  const folderUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select Log Folder'
  });

  if (folderUri && folderUri[0]) {
    const selectedPath = folderUri[0].fsPath;
    await config.update('logFilePath', selectedPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Log file path updated to: ${selectedPath}`);
  }
}