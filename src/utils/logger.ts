import * as vscode from 'vscode';

export function logInfo(message: string): void {
  console.log(message);
  vscode.window.showInformationMessage(message);
}

export function logError(message: string, error?: any): void {
  console.error(message, error);
  vscode.window.showErrorMessage(message);
}