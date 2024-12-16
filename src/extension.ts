import * as vscode from 'vscode';
import * as path from 'path';
import { getCommitMessage, pushChanges } from './services/gitService';
import { ensureDirectoryExists, appendToFile } from './services/fileService';
import { logInfo, logError } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "commit-tracker" is now active!');

	const config = vscode.workspace.getConfiguration('commitTracker');
	const logFilePath = config.get<string>('logFilePath');
	const logFile = config.get<string>('logFile')!;
	const diagnosticLogFile = config.get<string>('diagnosticLogFile')!;

	let lastProcessedCommit: string | null = context.globalState.get('lastProcessedCommit', null);

	const disposable = vscode.commands.registerCommand('commit-tracker.setLogFilePath', async () => {
		const uri = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Select Log File Folder'
		});

		if (uri && uri[0]) {
			const selectedPath = uri[0].fsPath;
			await config.update('logFilePath', selectedPath, vscode.ConfigurationTarget.Global);
			logInfo(`Log file path set to: ${selectedPath}`);
		}
	});

	context.subscriptions.push(disposable);

	if (!logFilePath) {
		vscode.window.showWarningMessage('Please configure the log file path for Commit Tracker.', 'Open Settings').then(selection => {
			if (selection === 'Open Settings') {
				vscode.commands.executeCommand('commit-tracker.setLogFilePath');
			}
		});
		return;
	}

	const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
	const api = gitExtension.getAPI(1);

	if (api) {
		api.repositories.forEach((repo: { state: { HEAD: { commit: any; name: any; }; onDidChange: (arg0: () => void) => void; }; rootUri: { fsPath: any; }; }) => {
			repo.state.onDidChange(async () => {
				const headCommit = repo.state.HEAD?.commit;
				const branch = repo.state.HEAD?.name;
				const repoPath = repo.rootUri.fsPath;

				if (headCommit && headCommit !== lastProcessedCommit) {
					lastProcessedCommit = headCommit;
					await context.globalState.update('lastProcessedCommit', headCommit);

					try {
						const message = await getCommitMessage(repoPath, headCommit);
						const commitDate = new Date().toISOString();
						const logMessage = `Commit: ${headCommit}\nMessage: ${message}\nDate: ${commitDate}\nBranch: ${branch}\nRepository Path: ${repoPath}\n\n`;

						logInfo(logMessage);

						// Ensure the directory exists
						const trackingFilePath = path.join(logFilePath, logFile);
						ensureDirectoryExists(trackingFilePath);

						if (branch === 'main' || branch === 'master') {
							logInfo(`Skipping logging for branch: ${branch}`);
							return;
						}

						// Append commit details to the log file
						await appendToFile(trackingFilePath, logMessage);
						logInfo('Commit details logged to commits.log');

						// Push changes to the remote repository
						await pushChanges(logFilePath, trackingFilePath, branch);
						logInfo('Changes pushed to the tracking repository');
					} catch (err) {
						const diagnosticLogFilePath = path.join(logFilePath, diagnosticLogFile);
						ensureDirectoryExists(diagnosticLogFilePath);
						logError('Failed to process commit:', diagnosticLogFilePath, err);
					}
				}
			});
		});
	}
}

export function deactivate() { }
