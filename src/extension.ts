import * as vscode from 'vscode';
import * as path from 'path';
import { getCommitMessage, pushChanges } from './services/gitService';
import { ensureDirectoryExists, appendToFile, validatePath } from './services/fileService';
import { logInfo, logError } from './utils/logger';
import { debounce } from './utils/debounce';
import { DisposableManager } from './utils/DisposableManager';
import { selectLogFolder, validateConfig } from './utils/configValidator.js';

let logFilePath: string;
let logFile: string;
let excludedBranches: string[];

export async function activate(context: vscode.ExtensionContext) {
	const isValidConfig = await validateConfig();
	if (!isValidConfig) {
		return;
	}

	logInfo('Commit Tracker extension activated');
	const disposableManager = DisposableManager.getInstance();

	const config = vscode.workspace.getConfiguration('commitTracker');
	logFilePath = config.get<string>('logFilePath')!;
	logFile = config.get<string>('logFile')!;
	excludedBranches = config.get<string[]>('excludedBranches')!;
	let lastProcessedCommit: string | null = context.globalState.get('lastProcessedCommit', null);

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
		logInfo('Git API available');
		const activeRepos = api.repositories.filter((repo: any) => repo.state.HEAD);
		activeRepos.forEach((repo: { state: { HEAD: { commit: any; name: any; }; onDidChange: (arg0: () => void) => void; }; rootUri: { fsPath: any; }; }) => {
			logInfo('Processing repository:');
			console.log(repo);
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

					// Ensure the directory exists
					const trackingFilePath = path.join(logFilePath, logFile);
					console.log('logFilePath:', logFilePath);
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
						await pushChanges(logFilePath, trackingFilePath);
						logInfo('Changes pushed to the tracking repository');
					} catch (err) {
						logError('Failed to push changes to the tracking repository:', err);
					}
				} catch (err) {
					logError('Failed to process commit:', err);
				}
			}, 300); // Adjust the debounce delay as needed

			const listener = repo.state.onDidChange(debouncedOnDidChange);
			const disposableListener = { dispose: () => listener };
			context.subscriptions.push(disposableListener);
			disposableManager.register(disposableListener);
		});
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e.affectsConfiguration('commitTracker')) {
				const isValid = await validateConfig();
				if (isValid) {
					const updatedConfig = vscode.workspace.getConfiguration('commitTracker');
					logFilePath = updatedConfig.get<string>('logFilePath')!;
					logFile = updatedConfig.get<string>('logFile')!;
					excludedBranches = updatedConfig.get<string[]>('excludedBranches')!;
					logInfo('Configuration updated');
				} else {
					logError('Configuration validation failed after changes.');
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('commit-tracker.selectLogFolder', selectLogFolder)
	);
}

export function deactivate(): void {
	const disposableManager = DisposableManager.getInstance();
	disposableManager.dispose();
	vscode.window.showInformationMessage('Commit Tracker deactivated.');
}
