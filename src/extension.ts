import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  logInfo,
  logError,
  initializeLogger,
  showOutputChannel,
} from "./utils/logger";
import { DisposableManager } from "./utils/DisposableManager";
import { selectLogFolder, validateConfig } from "./utils/configValidator";
import { RepositoryManager } from "./managers/RepositoryManager";
import { executeGitCommand, hasUnpushedCommits } from "./services/gitService";

// Add this line at the top level of the file
let statusBarItem: vscode.StatusBarItem;
let repositoryManager: RepositoryManager;

export async function activate(context: vscode.ExtensionContext) {
  // Create and show output channel immediately
  initializeLogger();
  showOutputChannel(true);

  logInfo("Commit Tracker extension activating...");

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = "$(git-commit) Tracking";
  statusBarItem.tooltip = "Commit Tracker is active";
  statusBarItem.command = "commit-tracker.logCurrentCommit";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  /**
   * Updates the status bar to show if there are unpushed commits
   */
  async function updateStatusBarWithUnpushedStatus() {
    try {
      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath");

      if (!logFilePath) {
        return; // No log path configured
      }

      const hasUnpushed = await hasUnpushedCommits(logFilePath);

      if (hasUnpushed) {
        statusBarItem.text = "$(git-commit) Unpushed Logs";
        statusBarItem.tooltip =
          "Commit Tracker has unpushed logs - click to push";
        statusBarItem.command = "commit-tracker.pushTrackerChanges";
      } else {
        statusBarItem.text = "$(git-commit) Tracking";
        statusBarItem.tooltip = "Commit Tracker is active";
        statusBarItem.command = "commit-tracker.logCurrentCommit";
      }
    } catch (error) {
      logError(`Error updating status bar: ${error}`);
	}
  }

  // Set up periodic checking for unpushed commits
  const checkInterval = setInterval(updateStatusBarWithUnpushedStatus, 60000); // Check every minute

  // Clean up the interval when deactivating
  context.subscriptions.push({
    dispose: () => clearInterval(checkInterval),
  });

  // Initial check
  updateStatusBarWithUnpushedStatus();

  // Check if Git extension is available
  const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
	if (!gitExtension) {
    const message =
      "Git extension is not available. Please ensure Git is installed and the Git extension is enabled.";
    logError(message);
    vscode.window.showErrorMessage(message);
    statusBarItem.text = "$(error) Git Not Found";
		return;
	}

  // Validate configuration
  const isValidConfig = await validateConfig();
  if (!isValidConfig) {
    logError(
      "Invalid configuration. Please update settings and restart the extension."
    );
    vscode.window.showErrorMessage(
      "Commit Tracker: Invalid configuration. Please update settings."
    );
    statusBarItem.text = "$(warning) Config Error";
		return;
	}

  logInfo("Commit Tracker configuration validated successfully");

  // Initialize repository manager
  repositoryManager = new RepositoryManager(context);
  const initialized = await repositoryManager.initialize();

  if (!initialized) {
    const message =
      "Failed to initialize repository manager. Check logs for details.";
    logError(message);
    vscode.window.showErrorMessage(message);
    statusBarItem.text = "$(warning) Init Failed";
					return;
				}

  logInfo("Commit Tracker repository manager initialized successfully");
  vscode.window.showInformationMessage(
    "Commit Tracker is now monitoring commits"
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-tracker.selectLogFolder",
      selectLogFolder
    ),
    vscode.commands.registerCommand(
      "commit-tracker.logCurrentCommit",
      async () => {
        logInfo("Manual commit logging triggered");
        showOutputChannel(false); // Show the output panel and focus on it
        statusBarItem.text = "$(sync~spin) Processing...";

        if (repositoryManager) {
          logInfo("Manually triggering commit logging");
          const gitExtension =
            vscode.extensions.getExtension("vscode.git")?.exports;
          if (gitExtension) {
            const api = gitExtension.getAPI(1);
            if (api && api.repositories.length > 0) {
              const repo = api.repositories[0];
              await repositoryManager.processCurrentRepository(repo);
              vscode.window.showInformationMessage(
                "Manually processed current commit"
              );
              statusBarItem.text = "$(git-commit) Tracking";
            } else {
              const errorMsg = "No Git repositories found";
              logError(errorMsg);
              vscode.window.showErrorMessage(errorMsg);
              statusBarItem.text = "$(error) No Repos";
            }
          } else {
            const errorMsg = "Git extension not found";
            logError(errorMsg);
            vscode.window.showErrorMessage(errorMsg);
            statusBarItem.text = "$(error) Git Not Found";
          }
        } else {
          const errorMsg = "Repository manager not initialized";
          logError(errorMsg);
          vscode.window.showErrorMessage(errorMsg);
          statusBarItem.text = "$(error) Not Initialized";
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-tracker.startMonitoring",
      async () => {
        if (repositoryManager) {
          logInfo("Manually starting commit monitoring");
          const gitExtension =
            vscode.extensions.getExtension("vscode.git")?.exports;
          if (gitExtension) {
            const api = gitExtension.getAPI(1);
            if (api && api.repositories.length > 0) {
              // Re-initialize repository listeners
              await repositoryManager.initialize();
              vscode.window.showInformationMessage("Commit monitoring started");
            } else {
              vscode.window.showErrorMessage("No Git repositories found");
            }
          }
        }
      }
    )
  );

  // Add this command to your activate function
  context.subscriptions.push(
    // In your "commit-tracker.forceLogLatestCommit" command handler:
    vscode.commands.registerCommand(
      "commit-tracker.forceLogLatestCommit",
      async () => {
        logInfo("Force logging latest commit");
        showOutputChannel(false); // Show the output panel and focus
        statusBarItem.text = "$(sync~spin) Force Processing...";

        if (repositoryManager) {
          const gitExtension =
            vscode.extensions.getExtension("vscode.git")?.exports;
          if (gitExtension) {
            const api = gitExtension.getAPI(1);
            if (api && api.repositories.length > 0) {
              try {
                const repo = api.repositories[0];
                const headCommit = repo.state.HEAD?.commit;

                logInfo(`Found latest commit: ${headCommit}`);

                if (headCommit) {
                  // Use the direct processing method
                  const repoPath = repo.rootUri.fsPath;
                  const branch = repo.state.HEAD?.name || "unknown";

                  await repositoryManager.processCommitDirectly(
                    repoPath,
                    headCommit,
                    branch
                  );
                  vscode.window.showInformationMessage(
                    `Forced logging of commit: ${headCommit}`
                  );
                } else {
                  vscode.window.showErrorMessage("No HEAD commit found");
						}

                statusBarItem.text = "$(git-commit) Tracking";
					} catch (error) {
                logError(`Error in force logging: ${error}`);
                vscode.window.showErrorMessage(`Error: ${error}`);
                statusBarItem.text = "$(error) Error";
					}
            } else {
              vscode.window.showErrorMessage("No Git repositories found");
              statusBarItem.text = "$(error) No Repos";
            }
          } else {
            vscode.window.showErrorMessage("Git extension not found");
            statusBarItem.text = "$(error) Git Not Found";
          }
        } else {
          vscode.window.showErrorMessage("Repository manager not initialized");
          statusBarItem.text = "$(error) Not Initialized";
        }
      }
    )
  );

  // Add this command to your extension.ts file
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-tracker.showDebugInfo",
      async () => {
        try {
          showOutputChannel(false); // Show and focus the output channel
          logInfo("=== DEBUG INFORMATION ===");

          // Log extension configuration
          const config = vscode.workspace.getConfiguration("commitTracker");
          const logFilePath = config.get<string>("logFilePath") || "not set";
          const logFile = config.get<string>("logFile") || "not set";
          const excludedBranches =
            config.get<string[]>("excludedBranches") || [];

          logInfo(
            `Configuration: Log path: ${logFilePath}, Log file: ${logFile}`
          );
          logInfo(`Excluded branches: ${excludedBranches.join(", ")}`);

          // Check if log directory exists and is writable
          try {
            if (fs.existsSync(logFilePath)) {
              logInfo(`Log directory exists: Yes`);

              // Check if it's writable
              const testFile = path.join(logFilePath, ".write-test");
              fs.writeFileSync(testFile, "test");
              fs.unlinkSync(testFile);
              logInfo("Log directory is writable: Yes");

              // Check if it's a git repository
              if (fs.existsSync(path.join(logFilePath, ".git"))) {
                logInfo("Log directory is a Git repository: Yes");

                // Check remote configuration
                const gitExtension =
                  vscode.extensions.getExtension("vscode.git")?.exports;
                if (gitExtension) {
                  const api = gitExtension.getAPI(1);
                  // Find the repository that matches the log path
                  const trackerRepo = api.repositories.find(
                    (repo: any) => repo.rootUri.fsPath === logFilePath
                  );

                  if (trackerRepo) {
                    logInfo(
                      "Tracker repository is recognized by VS Code Git extension: Yes"
                    );

                    // Show remote information
                    try {
                      const remotes = await executeGitCommand(
                        logFilePath,
                        "remote -v"
                      );
                      logInfo(`Configured remotes:\n${remotes || "None"}`);

                      const currentBranch = await executeGitCommand(
                        logFilePath,
                        "rev-parse --abbrev-ref HEAD"
                      );
                      logInfo(`Current branch: ${currentBranch}`);

                      try {
                        const trackingBranch = await executeGitCommand(
                          logFilePath,
                          `rev-parse --abbrev-ref ${currentBranch}@{upstream}`
                        );
                        logInfo(`Tracking branch: ${trackingBranch}`);
                      } catch (error) {
                        logInfo("No tracking branch configured");
                      }

                      const status = await executeGitCommand(
                        logFilePath,
                        "status -s"
                      );
                      logInfo(`Git status:\n${status || "Clean"}`);
                    } catch (error) {
                      logInfo(`Error getting Git information: ${error}`);
                    }
                  } else {
                    logInfo(
                      "Tracker repository is not recognized by VS Code Git extension"
                    );
                  }
                }
              } else {
                logInfo("Log directory is a Git repository: No");
              }

              // Check log file
              const fullLogPath = path.join(logFilePath, logFile);
              if (fs.existsSync(fullLogPath)) {
                const stats = fs.statSync(fullLogPath);
                logInfo(`Log file exists: Yes, size: ${stats.size} bytes`);

                // Read the last few lines of the log
                const content = fs.readFileSync(fullLogPath, "utf8");
                const lines = content.split("\n");
                const lastLines = lines.slice(-20).join("\n");
                logInfo(`Last lines of log file:\n${lastLines}`);
              } else {
                logInfo("Log file exists: No");
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

					try {
						await appendToFile(trackingFilePath, logMessage);
						logInfo('Commit details logged to commits.log');
					} catch (err) {
						logError('Failed to write to commits.log:', err);
						return;
					}

					try {
						await pushChanges(logFilePath, trackingFilePath);
						logInfo('Changes pushed to the tracking repository');
					} catch (err) {
						logError('Failed to push changes to the tracking repository:', err);
					}
				} catch (err) {
					logError('Failed to process commit:', err);
				}
			}, 300);

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
