import * as vscode from 'vscode';
import * as fs from 'fs';

export function logInfo(message: string): void {
  console.log(message);
  vscode.window.showInformationMessage(message);
}

export function logError(message: string, diagnosticLogFilePath: string, error?: any): void {
  console.error(message, error);
  vscode.window.showErrorMessage(message);

  const errorDetails = `${new Date().toISOString()} - ${message}\n${error ? error.stack || error : ''}\n\n`;
  fs.appendFile(diagnosticLogFilePath, errorDetails, (err) => {
    if (err) {
      console.error('Failed to write to diagnostic log file:', err);
    }
  });
}