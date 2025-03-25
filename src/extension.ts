import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  logInfo,
  logError,
  initializeLogger,
  showOutputChannel,
  toggleLogging,
  setLoggingState,
} from "./utils/logger";
import { DisposableManager } from "./utils/DisposableManager";
import { selectLogFolder, validateConfig } from "./utils/configValidator";
import { RepositoryManager } from "./managers/RepositoryManager";
import { executeGitCommand, hasUnpushedCommits } from "./services/gitService";
import { SetupWizard } from "./utils/setupWizard";

// Add this line at the top level of the file
let statusBarItem: vscode.StatusBarItem;
let repositoryManager: RepositoryManager;

export async function activate(context: vscode.ExtensionContext) {
  // Create and show output channel immediately
  initializeLogger();

  // Initialize logging state from configuration
  const config = vscode.workspace.getConfiguration("commitTracker");
  const enableLogging = config.get<boolean>("enableLogging", false); // Default to false
  setLoggingState(enableLogging);

  // Only show the output channel if logging is enabled
  if (enableLogging) {
    showOutputChannel(true);
  }

  logInfo("Commit Tracker extension activating...");

  // Check if setup has been completed
  const setupComplete = context.globalState.get<boolean>("setupComplete");
  if (!setupComplete) {
    logInfo("First-time setup required. Starting wizard...");
    const setupWizard = new SetupWizard(context);

    // Show initial notification
    vscode.window
      .showInformationMessage(
        "Welcome to Commit Tracker! Setting up your tracking repository...",
        "Configure Now"
      )
      .then((selection) => {
        if (selection === "Configure Now") {
          // Launch setup wizard
          setupWizard.run().then((success) => {
            if (success) {
              validateConfig().then((isValidConfig) => {
                if (isValidConfig) {
                  repositoryManager = new RepositoryManager(context);
                  repositoryManager.initialize().then(() => {
                    vscode.window.showInformationMessage(
                      "Commit Tracker is now configured and active"
                    );
                  });
                }
              });
            }
          });
        }
      });
  }

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

    // Offer to run setup wizard if configuration is invalid
    const setupOption = await vscode.window.showErrorMessage(
      "Commit Tracker: Invalid configuration. Would you like to run the setup wizard?",
      "Yes",
      "No"
    );

    if (setupOption === "Yes") {
      const setupWizard = new SetupWizard(context);
      const success = await setupWizard.run();

      if (success) {
        // Re-validate config
        const newIsValidConfig = await validateConfig();
        if (newIsValidConfig) {
          // Continue initialization
          repositoryManager = new RepositoryManager(context);
          const initialized = await repositoryManager.initialize();

          if (initialized) {
            statusBarItem.text = "$(git-commit) Tracking";
            vscode.window.showInformationMessage(
              "Commit Tracker is now monitoring commits"
            );
            return;
          }
        }
      }
    }

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

  // Register commands selectLogFolder, logCurrentCommit
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

  // startMonitoring
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

  // forceLogLatestCommit
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

  // showDebugInfo
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
            } else {
              logInfo("Log directory exists: No");
            }
          } catch (error) {
            logInfo(`Error checking log directory: ${error}`);
          }

          // Show information about active repositories
          const gitExtension =
            vscode.extensions.getExtension("vscode.git")?.exports;
          if (gitExtension) {
            const api = gitExtension.getAPI(1);
            logInfo(
              `Number of active Git repositories: ${api.repositories.length}`
            );

            for (const repo of api.repositories) {
              logInfo(`Repository: ${repo.rootUri.fsPath}`);
              logInfo(`Current HEAD: ${repo.state.HEAD?.commit || "None"}`);
              logInfo(`Current branch: ${repo.state.HEAD?.name || "None"}`);
            }
          }

          logInfo("=== END DEBUG INFORMATION ===");
          vscode.window.showInformationMessage(
            "Debug information logged to output channel"
          );
        } catch (error) {
          logError(`Error getting debug information: ${error}`);
          vscode.window.showErrorMessage(
            `Error getting debug information: ${error}`
          );
        }
      }
    )
  );

  // pushTrackerChanges
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-tracker.pushTrackerChanges",
      async () => {
        try {
          const config = vscode.workspace.getConfiguration("commitTracker");
          const logFilePath = config.get<string>("logFilePath");

          if (!logFilePath) {
            vscode.window.showErrorMessage("Log file path not configured");
            return;
          }

          logInfo("Manually pushing tracking repository changes");
          showOutputChannel(false); // Show and focus the output
          statusBarItem.text = "$(sync~spin) Pushing...";

          // Create and execute a more detailed script
          const scriptPath = path.join(
            os.tmpdir(),
            `git-manual-push-${Date.now()}.sh`
          );

          // Create a script that shows detailed information and auto-closes
          const scriptContent = `#!/bin/bash
  # Manual push script
  echo "=== Commit Tracker Manual Push ==="
  echo "Current directory: ${logFilePath}"
  cd "${logFilePath}"
  echo "Git status:"
  git status
  echo "Pushing changes..."
  git push
  PUSH_RESULT=$?
  echo "Push complete, new status:"
  git status
  
  if [ $PUSH_RESULT -eq 0 ]; then
    echo "Push successful!"
  else
    echo "Push failed with status $PUSH_RESULT"
    echo "You may need to push manually or set up credentials"
  fi
  
  echo "Terminal will close in 5 seconds..."
  sleep 5
  `;

          fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

          // Use the VS Code terminal to run the script so the user can see the output and respond to prompts
          const terminal = vscode.window.createTerminal({
            name: "Commit Tracker",
            hideFromUser: false, // Initially show to the user
            location: vscode.TerminalLocation.Panel, // Put it in the panel
            isTransient: true, // Mark as transient so it can be reused
          });
          // Show it but don't focus it (keep user in their code)
          terminal.show(false);
          terminal.sendText(`bash "${scriptPath}" && exit || exit`);

          // We can't tell if the push succeeded since it's in a terminal, but we can update the UI
          statusBarItem.text = "$(git-commit) Tracking";
          vscode.window.showInformationMessage("Push command sent to terminal");

          // Clean up the script after a delay
          setTimeout(() => {
            try {
              fs.unlinkSync(scriptPath);
            } catch (e) {
              // Ignore errors cleaning up the script
            }
          }, 10000);

          // Update status after a reasonable delay
          setTimeout(() => {
            updateStatusBarWithUnpushedStatus();
          }, 10000);
        } catch (error) {
          logError(`Manual push failed: ${error}`);
          statusBarItem.text = "$(error) Push Failed";
          vscode.window.showErrorMessage(`Push failed: ${error}`);

          // Restore normal status after a delay
          setTimeout(() => {
            statusBarItem.text = "$(git-commit) Tracking";
          }, 5000);
        }
      }
    )
  );

  // Register the checkUnpushedStatus command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-tracker.checkUnpushedStatus",
      async () => {
        try {
          await updateStatusBarWithUnpushedStatus();
          return true;
        } catch (error) {
          logError(`Failed to check unpushed status: ${error}`);
          return false;
        }
      }
    )
  );

  // Toggle Logging
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "commit-tracker.toggleLogging",
      async () => {
        const isEnabled = toggleLogging();
        if (isEnabled) {
          showOutputChannel(false); // Show and focus the output channel
          vscode.window.showInformationMessage(
            "Commit Tracker: Logging enabled"
          );
          // Update status bar if needed
          if (statusBarItem.text.includes("Tracking")) {
            statusBarItem.text = "$(git-commit) Tracking $(output)";
          }
        } else {
          vscode.window.showInformationMessage(
            "Commit Tracker: Logging disabled"
          );
          // Update status bar if needed
          if (statusBarItem.text.includes("$(output)")) {
            statusBarItem.text = statusBarItem.text.replace(" $(output)", "");
          }
        }
      }
    )
  );

  // Setup Tracker command
  context.subscriptions.push(
    vscode.commands.registerCommand("commit-tracker.setupTracker", async () => {
      logInfo("Starting tracker setup wizard");
      showOutputChannel(true);

      const setupWizard = new SetupWizard(context);
      const success = await setupWizard.run();

      if (success) {
        // Re-validate config and initialize
        const isValidConfig = await validateConfig();
        if (isValidConfig) {
          if (repositoryManager) {
            // If repositoryManager already exists, dispose it first
            const disposableManager = DisposableManager.getInstance();
            disposableManager.dispose();
          }

          // Create a new repository manager
          repositoryManager = new RepositoryManager(context);
          await repositoryManager.initialize();
          vscode.window.showInformationMessage(
            "Commit Tracker is now configured and active"
          );

          // Update status bar
          statusBarItem.text = "$(git-commit) Tracking";
          statusBarItem.tooltip = "Commit Tracker is active";
          statusBarItem.command = "commit-tracker.logCurrentCommit";
        }
      }
    })
  );

  // Reset Setup command
  context.subscriptions.push(
    vscode.commands.registerCommand("commit-tracker.resetSetup", async () => {
      const setupWizard = new SetupWizard(context);
      await setupWizard.resetSetup();
      vscode.window.showInformationMessage(
        "Commit Tracker setup has been reset. Run the Setup Tracking Repository command to reconfigure."
      );

      // Update status bar to show configuration needed
      statusBarItem.text = "$(warning) Setup Needed";
      statusBarItem.tooltip = "Commit Tracker needs to be set up";
      statusBarItem.command = "commit-tracker.setupTracker";
    })
  );

  // Update status bar to show logging state if enabled
  if (enableLogging && statusBarItem.text.includes("Tracking")) {
    statusBarItem.text = "$(git-commit) Tracking $(output)";
  }
}

export function deactivate(): void {
  const disposableManager = DisposableManager.getInstance();
  disposableManager.dispose();
  vscode.window.showInformationMessage("Commit Tracker deactivated.");
}
