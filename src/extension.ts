
import { exec } from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "commit-tracker" is now active!');

	const config = vscode.workspace.getConfiguration('commitTracker');
	const logFilePath = config.get<string>('logFilePath');

	const disposable = vscode.commands.registerCommand('commit-tracker.setLogFilePath', async () => {
		const uri = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Select Log File Folder'
		});

		if (uri && uri[0]) {
			const selectedPath = path.join(uri[0].fsPath, 'commits.log');
			await config.update('logFilePath', selectedPath, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Log file path set to: ${selectedPath}`);
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
		console.log('Git API is available');
		api.repositories.forEach((repo: { state: { HEAD: { commit: any; name: any; }; onDidChange: (arg0: () => void) => void; }; rootUri: { fsPath: any; }; }) => {
			repo.state.onDidChange(() => {
				const headCommit = repo.state.HEAD?.commit;
				const branch = repo.state.HEAD?.name;
				const repoPath = repo.rootUri.fsPath;

				exec(`git show -s --format=%B ${headCommit}`, { cwd: repoPath }, (err, stdout) => {
					if (err) {
						console.error('Failed to get commit message:', err);
						return;
					}
					const commitMessage = stdout.trim();
					const logMessage = `Commit: ${headCommit}\nMessage: ${commitMessage}\nBranch: ${branch}\nRepository Path: ${repoPath}\n\n`;

					console.log(logMessage);

					// Ensure the directory exists
					const logDir = path.dirname(logFilePath);
					fs.mkdirSync(logDir, { recursive: true });

					fs.appendFile(logFilePath, logMessage, async (err) => {
						if (err) {
							console.error('Failed to write to commits.log:', err);
						} else {
							console.log('Commit details logged to commits.log');

							// Use simple-git to push changes to the tracking repository
							const git: SimpleGit = simpleGit(logDir);
							try {
								await git.add(logFilePath);
								await git.commit('Update commit log');
								await git.push('origin', branch);
								console.log('Changes pushed to the tracking repository');
							} catch (pushErr) {
								console.error('Failed to push changes:', pushErr);
							}
						}
					});
				});
			});
		});
		// 	console.log('Git API state changed');
		// 	// const repositories = api.repositories;
		// 	// repositories.forEach((repo: { state: { onDidChange: (arg0: () => void) => void; HEAD: { commit: any; name: any; }; }; rootUri: { fsPath: any; }; }) => {
		// 	// 	repo.state.onDidChange(() => {
		// 	// 		const headCommit = repo.state.HEAD?.commit;
		// 	// 		const branch = repo.state.HEAD?.name;
		// 	// 		const repoPath = repo.rootUri.fsPath;

		// 	// 		if (headCommit) {
		// 	// 			console.log(`Commit: ${headCommit}`);
		// 	// 			console.log(`Branch: ${branch}`);
		// 	// 			console.log(`Repository Path: ${repoPath}`);
		// 	// 		}
		// 	// 	});
		// 	// });
		// });
	}
}

export function deactivate() { }
