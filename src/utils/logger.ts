import * as vscode from 'vscode';
import * as fs from 'fs';
import path from 'path';
import { ensureDirectoryExists } from '../services/fileService';

export function logInfo(message: string): void {
  console.log(message);
  vscode.window.showInformationMessage(message);
}

export function logError(message: string, error?: any): void {
  console.error(message, error);
  vscode.window.showErrorMessage(message);

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