import * as vscode from 'vscode';
import * as fs from 'fs';
import path from 'path';
import { ensureDirectoryExists } from '../services/fileService';
import { selectLogFolder } from './configValidator';

export function logInfo(message: string): void {
  const config = vscode.workspace.getConfiguration('commitTracker');
  const showNotifications = config.get<boolean>('enableNotifications');
  if (showNotifications) {
    vscode.window.showInformationMessage(message);
  }
}

export async function logError(message: string, error?: any): Promise<void> {
  console.error(message, error);
  const action = message.includes('Failed to ensure directory exists:') ? '' : 'View Details';
  const selection = await vscode.window.showErrorMessage(message, action);

  if (selection === 'View Details') {
    await selectLogFolder();
  }

  const config = vscode.workspace.getConfiguration('commitTracker');
  const logFilePath = config.get<string>('logFilePath');
  const diagnosticLogFile = config.get<string>('diagnosticLogFile') || 'diagnostic.log';
  const diagnosticLogFilePath = logFilePath ? path.join(logFilePath, diagnosticLogFile) : '';
  ensureDirectoryExists(diagnosticLogFilePath);

  const errorDetails = `${new Date().toISOString()} - ${message}\n${error ? error.stack || error : ''}\n\n`;
  fs.appendFile(diagnosticLogFilePath, errorDetails, (err) => {
    if (err) {
      console.error('Failed to write to diagnostic log file:', err);
    }
  });
}