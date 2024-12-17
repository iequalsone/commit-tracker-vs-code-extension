import * as vscode from 'vscode';
import * as path from 'path';
import { getCommitMessage, pushChanges } from './services/gitService';
import { ensureDirectoryExists, appendToFile, validatePath } from './services/fileService';
import { logInfo, logError } from './utils/logger';
import { debounce } from './utils/debounce';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "commit-tracker" is now active!');

	const config = vscode.workspace.getConfiguration('commitTracker');
	const logFilePath = config.get<string>('logFilePath');
	const logFile = config.get<string>('logFile')!;
	const excludedBranches = config.get<string[]>('excludedBranches')!;
	let lastProcessedCommit: string | null = context.globalState.get('lastProcessedCommit', null);

	const disposable = vscode.commands.registerCommand('commit-tracker.setLogFilePath', async () => {
		try {
			const uri = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Select Log File Folder'
			});

			if (uri && uri[0]) {
				const selectedPath = uri[0].fsPath;
				if (!validatePath(selectedPath)) {
					throw new Error('Invalid log file path.');
				}
				await config.update('logFilePath', selectedPath, vscode.ConfigurationTarget.Global);
				logInfo(`Log file path set to: ${selectedPath}`);
			}
		} catch (err) {
			logError('Failed to set log file path:', err);
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
	if (!gitExtension) {
		logError('Git extension is not available. Please ensure Git is installed and the Git extension is enabled.');
		return;
	}

	const api = gitExtension.getAPI(1);
	if (!api) {
		logError('Failed to get Git API. Please ensure the Git extension is enabled.');
		return;
	}

	if (api) {
		api.repositories.forEach((repo: { state: { HEAD: { commit: any; name: any; }; onDidChange: (arg0: () => void) => void; }; rootUri: { fsPath: any; }; }) => {
			const debouncedOnDidChange = debounce(async () => {
				const headCommit = repo.state.HEAD?.commit;
				const branch = repo.state.HEAD?.name;
				const repoPath = repo.rootUri.fsPath;

				if (!headCommit) {
					logError('No HEAD commit found. Please ensure the repository is in a valid state.');
					return;
				}

				if (headCommit === lastProcessedCommit) {
					return;
				}

				lastProcessedCommit = headCommit;
				await context.globalState.update('lastProcessedCommit', headCommit);

				try {
					const message = await getCommitMessage(repoPath, headCommit);
					const commitDate = new Date().toISOString();
					const logMessage = `Commit: ${headCommit}\nMessage: ${message}\nDate: ${commitDate}\nBranch: ${branch}\nRepository Path: ${repoPath}\n\n`;

					logInfo(logMessage);

					// Ensure the directory exists
					const trackingFilePath = path.join(logFilePath, logFile);
					try {
						if (!validatePath(trackingFilePath)) {
							throw new Error('Invalid tracking file path.');
						}
						ensureDirectoryExists(trackingFilePath);
					} catch (err) {
						logError('Failed to ensure directory exists:', err);
						return;
					}

					if (excludedBranches.includes(branch)) {
						logInfo(`Skipping logging for branch: ${branch}`);
						return;
					}

					// Append commit details to the log file
					try {
						await appendToFile(trackingFilePath, logMessage);
						logInfo('Commit details logged to commits.log');
					} catch (err) {
						logError('Failed to write to commits.log:', err);
						return;
					}

					// Push changes to the remote repository
					try {
						await pushChanges(repoPath, trackingFilePath, branch);
						logInfo('Changes pushed to the tracking repository');
					} catch (err) {
						logError('Failed to push changes to the tracking repository:', err);
					}
				} catch (err) {
					logError('Failed to process commit:', err);
				}
			}, 300); // Adjust the debounce delay as needed

			repo.state.onDidChange(debouncedOnDidChange);
		});
	}
}

export function deactivate() { }
