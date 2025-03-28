import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GitService } from "../../services/gitService";
import { LogService } from "../../services/logService";
import { SetupManager } from "../setup/setupManager";
import { StatusManager } from "../status/statusManager";
import {
  RepositoryEvent,
  RepositoryManager,
} from "../repository/repositoryManager";

/**
 * Manages all extension commands and their registration
 */
export class CommandManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly gitService: GitService;
  private readonly logService: LogService;
  private readonly setupManager: SetupManager;
  private readonly statusManager: StatusManager;
  private readonly repositoryManager: RepositoryManager;
  private disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    gitService: GitService,
    logService: LogService,
    setupManager: SetupManager,
    statusManager: StatusManager,
    repositoryManager: RepositoryManager
  ) {
    this.context = context;
    this.gitService = gitService;
    this.logService = logService;
    this.setupManager = setupManager;
    this.statusManager = statusManager;
    this.repositoryManager = repositoryManager;
  }

  private setupRepositoryEventListeners(): void {
    if (this.repositoryManager) {
      this.repositoryManager.on(
        RepositoryEvent.PUSH_REQUESTED,
        this.handlePushRequest.bind(this)
      );

      this.repositoryManager.on(RepositoryEvent.ERROR, (error, operation) => {
        this.logService.error(
          `Repository error during ${operation}: ${error.message}`
        );
        // Only show notification for significant errors, not routine ones
        if (
          !operation.includes("already processed") &&
          !operation.includes("Skipping")
        ) {
          vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
      });

      // Listen for specific error types to provide contextual UI feedback
      this.repositoryManager.on(
        RepositoryEvent.ERROR_GIT_OPERATION,
        (error) => {
          vscode.window.showErrorMessage(
            `Git error: ${error.message}. You may need to fix Git issues manually.`
          );
        }
      );
    }
  }

  /**
   * Handle push requests from the RepositoryManager
   * @param logFilePath Path to the log directory
   * @param trackingFilePath Complete path to the tracking file
   */
  private async handlePushRequest(
    logFilePath: string,
    trackingFilePath: string
  ): Promise<void> {
    try {
      this.logService.info("Push request received from RepositoryManager");
      this.statusManager.setProcessingStatus("Pushing...");

      // Create and execute a script to push changes
      const scriptPath = path.join(os.tmpdir(), `git-push-${Date.now()}.sh`);

      const scriptContent = `#!/bin/bash
# Automatic push script from Commit Tracker
echo "=== Commit Tracker Push Operation ==="
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

      // Use VS Code terminal to show output
      const terminal = this.createGitOperationTerminal(
        logFilePath,
        scriptContent,
        "Commit Tracker Push"
      );

      // Update status after delay to allow push to complete
      setTimeout(() => {
        this.statusManager.updateUnpushedStatus();
      }, 10000);
    } catch (error) {
      this.logService.error(`Failed to handle push request: ${error}`);
      this.statusManager.setErrorStatus("Push Failed");

      // Restore normal status after delay
      setTimeout(() => {
        this.statusManager.setTrackingStatus();
      }, 5000);
    }
  }

  /**
   * Registers all commands for the extension
   */
  public registerCommands(): void {
    this.logService.info("Registering extension commands");

    this.registerCommand(
      "commitTracker.manageCacheStatus",
      this.manageCacheStatus.bind(this)
    );

    // Core commands
    this.registerCommand(
      "commitTracker.showDetails",
      this.showCommitDetails.bind(this)
    );
    this.registerCommand(
      "commitTracker.refresh",
      this.refreshStatus.bind(this)
    );
    this.registerCommand(
      "commitTracker.openSettings",
      this.openSettings.bind(this)
    );

    // Setup related commands
    this.registerCommand(
      "commitTracker.setupTracker",
      this.setupTracker.bind(this)
    );
    this.registerCommand(
      "commitTracker.resetSetup",
      this.resetSetup.bind(this)
    );
    this.registerCommand(
      "commitTracker.selectLogFolder",
      this.selectLogFolder.bind(this)
    );

    // Repository/tracking related commands
    this.registerCommand(
      "commitTracker.showRepositoryStatus",
      this.showRepositoryStatus.bind(this)
    );
    this.registerCommand(
      "commitTracker.logCurrentCommit",
      this.logCurrentCommit.bind(this)
    );
    this.registerCommand(
      "commitTracker.startMonitoring",
      this.startMonitoring.bind(this)
    );
    this.registerCommand(
      "commitTracker.forceLogLatestCommit",
      this.forceLogLatestCommit.bind(this)
    );
    this.setupRepositoryEventListeners();

    // Status/sync related commands
    this.registerCommand(
      "commitTracker.checkUnpushedStatus",
      this.checkUnpushedStatus.bind(this)
    );
    this.registerCommand(
      "commitTracker.pushTrackerChanges",
      this.pushTrackerChanges.bind(this)
    );

    // Debug/utility commands
    this.registerCommand(
      "commitTracker.showDebugInfo",
      this.showDebugInfo.bind(this)
    );
    this.registerCommand(
      "commitTracker.toggleLogging",
      this.toggleLogging.bind(this)
    );
  }

  /**
   * Helper method to register a command and track its disposable
   */
  private registerCommand(
    commandId: string,
    handler: (...args: any[]) => any
  ): void {
    const disposable = vscode.commands.registerCommand(commandId, handler);
    this.disposables.push(disposable);
    this.context.subscriptions.push(disposable);
  }

  /**
   * Command handler: Manage cache status
   */
  private async manageCacheStatus(): Promise<void> {
    try {
      this.logService.showOutput(false);
      this.logService.info("=== CACHE STATUS ===");

      if (!this.repositoryManager) {
        vscode.window.showErrorMessage("Repository manager not initialized");
        return;
      }

      const cacheStatus = this.repositoryManager.getCacheStatus();

      if (cacheStatus.isFailure()) {
        this.logService.error(
          `Failed to get cache status: ${cacheStatus.error.message}`
        );
        vscode.window.showErrorMessage(
          `Failed to get cache status: ${cacheStatus.error.message}`
        );
        return;
      }

      const status = cacheStatus.value;

      this.logService.info(
        `Last processed commit: ${status.lastProcessedCommit || "none"}`
      );
      this.logService.info(
        `Repositories tracked: ${status.repositoriesTracked}`
      );
      this.logService.info(`Cache created: ${status.cacheCreated}`);
      this.logService.info(
        `Cache last updated: ${status.cacheLastUpdated || "never"}`
      );
      this.logService.info(
        `Repository status entries: ${status.cacheSizes.repositoryStatus}`
      );
      this.logService.info(
        `Commit history cached: ${
          status.cacheSizes.commitHistory ? "Yes" : "No"
        }`
      );
      this.logService.info(
        `Statistics cached: ${status.cacheSizes.statistics ? "Yes" : "No"}`
      );
      this.logService.info(
        `Unpushed commits cached: ${
          status.cacheSizes.unpushedCommits ? "Yes" : "No"
        }`
      );

      // Ask user if they want to clear cache
      const action = await vscode.window.showQuickPick(
        [
          "View Cache Status Only",
          "Clear Repository Status Cache",
          "Clear Commit History Cache",
          "Clear Statistics Cache",
          "Clear Unpushed Commits Cache",
          "Clear All Caches",
        ],
        { placeHolder: "Select action" }
      );

      if (!action || action === "View Cache Status Only") {
        return;
      }

      switch (action) {
        case "Clear Repository Status Cache":
          this.repositoryManager.invalidateCache("repositoryStatus");
          vscode.window.showInformationMessage(
            "Repository status cache cleared"
          );
          break;
        case "Clear Commit History Cache":
          this.repositoryManager.invalidateCache("commitHistory");
          vscode.window.showInformationMessage("Commit history cache cleared");
          break;
        case "Clear Statistics Cache":
          this.repositoryManager.invalidateCache("statistics");
          vscode.window.showInformationMessage("Statistics cache cleared");
          break;
        case "Clear Unpushed Commits Cache":
          this.repositoryManager.invalidateCache("unpushedCommits");
          vscode.window.showInformationMessage(
            "Unpushed commits cache cleared"
          );
          break;
        case "Clear All Caches":
          this.repositoryManager.invalidateCache();
          vscode.window.showInformationMessage("All caches cleared");
          break;
      }

      this.logService.info("=== END CACHE STATUS ===");
    } catch (error) {
      this.logService.error(`Error managing cache: ${error}`);
      vscode.window.showErrorMessage(`Error managing cache: ${error}`);
    }
  }

  /**
   * Command handler: Show commit details
   */
  private async showCommitDetails(): Promise<void> {
    this.logService.info("Showing commit details");

    try {
      const hasUnpushedCommits = await this.gitService.hasUnpushedCommits();

      if (hasUnpushedCommits) {
        vscode.window.showInformationMessage("You have unpushed commits");
      } else {
        vscode.window.showInformationMessage("All commits are pushed");
      }
    } catch (error) {
      this.logService.error("Error showing commit details", error);
      vscode.window.showErrorMessage("Failed to show commit details");
    }
  }

  /**
   * Command handler: Refresh status
   */
  private refreshStatus(): void {
    this.logService.info("Manual refresh requested");
    this.statusManager.refresh();
  }

  /**
   * Command handler: Open extension settings
   */
  private openSettings(): void {
    this.logService.info("Opening extension settings");
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "commitTracker"
    );
  }

  /**
   * Command handler: Setup tracker repository
   */
  private async setupTracker(): Promise<void> {
    this.logService.info("Starting tracker setup wizard");
    this.logService.showOutput(true);

    const success = await this.setupManager.runSetupWizard();

    if (success) {
      // Use validateConfiguration() instead of validateConfig()
      const isValidConfig = this.setupManager.validateConfiguration();
      if (isValidConfig) {
        // Initialize repository manager
        await this.repositoryManager.initialize();
        vscode.window.showInformationMessage(
          "Commit Tracker is now configured and active"
        );

        // Update status bar
        this.statusManager.setTrackingStatus();
      }
    }
  }

  /**
   * Command handler: Reset setup
   */
  private async resetSetup(): Promise<void> {
    await this.setupManager.resetSetup();
    vscode.window.showInformationMessage(
      "Commit Tracker setup has been reset. Run the Setup Tracking Repository command to reconfigure."
    );

    // Update status bar to show configuration needed
    this.statusManager.setSetupNeededStatus();
  }

  /**
   * Command handler: Select log folder
   */
  private async selectLogFolder(): Promise<void> {
    await this.setupManager.selectLogFolder();
  }

  /**
   * Command handler: Log current commit
   */
  private async logCurrentCommit(): Promise<void> {
    this.logService.info("Manual commit logging triggered");
    this.logService.showOutput(false);
    this.statusManager.setProcessingStatus();

    try {
      const gitExtension =
        vscode.extensions.getExtension("vscode.git")?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        if (api && api.repositories.length > 0) {
          const repo = api.repositories[0];
          const repoPath = repo.rootUri.fsPath;
          const headCommit = repo.state.HEAD?.commit;
          const branch = repo.state.HEAD?.name || "unknown";

          if (headCommit) {
            await this.repositoryManager.processCommitDirectly(
              repoPath,
              headCommit,
              branch
            );
            vscode.window.showInformationMessage(
              "Manually processed current commit"
            );
          } else {
            vscode.window.showErrorMessage("No HEAD commit found");
          }
          this.statusManager.setTrackingStatus();
        } else {
          const errorMsg = "No Git repositories found";
          this.logService.error(errorMsg);
          vscode.window.showErrorMessage(errorMsg);
          this.statusManager.setErrorStatus("No Repos");
        }
      } else {
        const errorMsg = "Git extension not found";
        this.logService.error(errorMsg);
        vscode.window.showErrorMessage(errorMsg);
        this.statusManager.setErrorStatus("Git Not Found");
      }
    } catch (error) {
      this.logService.error(`Error logging commit: ${error}`);
      vscode.window.showErrorMessage(`Error: ${error}`);
      this.statusManager.setErrorStatus("Error");
    }
  }

  /**
   * Command handler: Start monitoring
   */
  private async startMonitoring(): Promise<void> {
    if (this.repositoryManager) {
      this.logService.info("Manually starting commit monitoring");
      const gitExtension =
        vscode.extensions.getExtension("vscode.git")?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        if (api && api.repositories.length > 0) {
          // Re-initialize repository listeners
          await this.repositoryManager.initialize();
          vscode.window.showInformationMessage("Commit monitoring started");
          this.statusManager.setTrackingStatus();
        } else {
          vscode.window.showErrorMessage("No Git repositories found");
          this.statusManager.setErrorStatus("No Repos");
        }
      } else {
        vscode.window.showErrorMessage("Git extension not found");
        this.statusManager.setErrorStatus("Git Not Found");
      }
    } else {
      vscode.window.showErrorMessage("Repository manager not initialized");
      this.statusManager.setErrorStatus("Not Initialized");
    }
  }

  /**
   * Command handler: Force log latest commit
   */
  private async forceLogLatestCommit(): Promise<void> {
    this.logService.info("Force logging latest commit");
    this.logService.showOutput(false);
    this.statusManager.setProcessingStatus("Force Processing...");

    try {
      const gitExtension =
        vscode.extensions.getExtension("vscode.git")?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        if (api && api.repositories.length > 0) {
          const repo = api.repositories[0];
          const headCommit = repo.state.HEAD?.commit;

          this.logService.info(`Found latest commit: ${headCommit}`);

          if (headCommit) {
            const repoPath = repo.rootUri.fsPath;
            const branch = repo.state.HEAD?.name || "unknown";

            await this.repositoryManager.processCommitDirectly(
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

          this.statusManager.setTrackingStatus();
        } else {
          vscode.window.showErrorMessage("No Git repositories found");
          this.statusManager.setErrorStatus("No Repos");
        }
      } else {
        vscode.window.showErrorMessage("Git extension not found");
        this.statusManager.setErrorStatus("Git Not Found");
      }
    } catch (error) {
      this.logService.error(`Error force logging: ${error}`);
      vscode.window.showErrorMessage(`Error: ${error}`);
      this.statusManager.setErrorStatus("Error");
    }
  }

  /**
   * Command handler: Check for unpushed status
   */
  private async checkUnpushedStatus(): Promise<boolean> {
    try {
      await this.statusManager.updateUnpushedStatus();
      return true;
    } catch (error) {
      this.logService.error(`Failed to check unpushed status: ${error}`);
      return false;
    }
  }

  /**
   * Command handler: Push tracker changes
   */
  private async pushTrackerChanges(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath");

      if (!logFilePath) {
        vscode.window.showErrorMessage("Log file path not configured");
        return;
      }

      this.logService.info("Manually pushing tracking repository changes");
      this.logService.showOutput(false);
      this.statusManager.setProcessingStatus("Pushing...");

      // Create and execute a script to push changes
      const scriptPath = path.join(
        os.tmpdir(),
        `git-manual-push-${Date.now()}.sh`
      );

      // Create a script with detailed information
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

      // Use VS Code terminal to show output
      const terminal = vscode.window.createTerminal({
        name: "Commit Tracker",
        hideFromUser: false,
        location: vscode.TerminalLocation.Panel,
        isTransient: true,
      });
      terminal.show(false);
      terminal.sendText(`bash "${scriptPath}" && exit || exit`);

      this.statusManager.setTrackingStatus();
      vscode.window.showInformationMessage("Push command sent to terminal");

      // Clean up script after delay
      setTimeout(() => {
        try {
          fs.unlinkSync(scriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }, 10000);

      // Update status after delay
      setTimeout(() => {
        this.statusManager.updateUnpushedStatus();
      }, 10000);
    } catch (error) {
      this.logService.error(`Manual push failed: ${error}`);
      this.statusManager.setErrorStatus("Push Failed");
      vscode.window.showErrorMessage(`Push failed: ${error}`);

      // Restore normal status after delay
      setTimeout(() => {
        this.statusManager.setTrackingStatus();
      }, 5000);
    }
  }

  /**
   * Command handler: Show debug info
   */
  private async showDebugInfo(): Promise<void> {
    try {
      this.logService.showOutput(false);
      this.logService.info("=== DEBUG INFORMATION ===");

      // Log extension configuration
      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath") || "not set";
      const logFile = config.get<string>("logFile") || "not set";
      const excludedBranches = config.get<string[]>("excludedBranches") || [];

      this.logService.info(
        `Configuration: Log path: ${logFilePath}, Log file: ${logFile}`
      );
      this.logService.info(`Excluded branches: ${excludedBranches.join(", ")}`);

      // Check if log directory exists and is writable
      try {
        if (fs.existsSync(logFilePath)) {
          this.logService.info(`Log directory exists: Yes`);

          // Check if it's writable
          const testFile = path.join(logFilePath, ".write-test");
          fs.writeFileSync(testFile, "test");
          fs.unlinkSync(testFile);
          this.logService.info("Log directory is writable: Yes");

          // Check if it's a git repository
          if (fs.existsSync(path.join(logFilePath, ".git"))) {
            this.logService.info("Log directory is a Git repository: Yes");

            // Check remote configuration
            const gitRemotes = await this.gitService.executeGitCommand(
              logFilePath,
              "remote -v"
            );
            this.logService.info(
              `Configured remotes:\n${gitRemotes || "None"}`
            );

            const currentBranch = await this.gitService.executeGitCommand(
              logFilePath,
              "rev-parse --abbrev-ref HEAD"
            );
            this.logService.info(`Current branch: ${currentBranch}`);

            try {
              const trackingBranch = await this.gitService.executeGitCommand(
                logFilePath,
                `rev-parse --abbrev-ref ${currentBranch}@{upstream}`
              );
              this.logService.info(`Tracking branch: ${trackingBranch}`);
            } catch (error) {
              this.logService.info("No tracking branch configured");
            }

            const status = await this.gitService.executeGitCommand(
              logFilePath,
              "status -s"
            );
            this.logService.info(`Git status:\n${status || "Clean"}`);
          } else {
            this.logService.info("Log directory is a Git repository: No");
          }

          // Check log file
          const fullLogPath = path.join(logFilePath, logFile);
          if (fs.existsSync(fullLogPath)) {
            const stats = fs.statSync(fullLogPath);
            this.logService.info(
              `Log file exists: Yes, size: ${stats.size} bytes`
            );

            // Read last few lines of the log
            const content = fs.readFileSync(fullLogPath, "utf8");
            const lines = content.split("\n");
            const lastLines = lines.slice(-20).join("\n");
            this.logService.info(`Last lines of log file:\n${lastLines}`);
          } else {
            this.logService.info("Log file exists: No");
          }
        } else {
          this.logService.info("Log directory exists: No");
        }
      } catch (error) {
        this.logService.info(`Error checking log directory: ${error}`);
      }

      // Show info about active repositories
      const gitExtension =
        vscode.extensions.getExtension("vscode.git")?.exports;
      if (gitExtension) {
        const api = gitExtension.getAPI(1);
        this.logService.info(
          `Number of active Git repositories: ${api.repositories.length}`
        );

        for (const repo of api.repositories) {
          this.logService.info(`Repository: ${repo.rootUri.fsPath}`);
          this.logService.info(
            `Current HEAD: ${repo.state.HEAD?.commit || "None"}`
          );
          this.logService.info(
            `Current branch: ${repo.state.HEAD?.name || "None"}`
          );
        }
      }

      this.logService.info("=== END DEBUG INFORMATION ===");
      vscode.window.showInformationMessage(
        "Debug information logged to output channel"
      );
    } catch (error) {
      this.logService.error(`Error getting debug information: ${error}`);
      vscode.window.showErrorMessage(
        `Error getting debug information: ${error}`
      );
    }
  }

  /**
   * Command handler: Toggle logging
   */
  private toggleLogging(): void {
    const isEnabled = this.logService.toggleLogging();
    if (isEnabled) {
      this.logService.showOutput(false);
      vscode.window.showInformationMessage("Commit Tracker: Logging enabled");
      this.statusManager.updateLoggingStatus(true);
    } else {
      vscode.window.showInformationMessage("Commit Tracker: Logging disabled");
      this.statusManager.updateLoggingStatus(false);
    }
  }

  /**
   * Command handler: Show repository status
   */
  private async showRepositoryStatus(): Promise<void> {
    try {
      if (!this.repositoryManager) {
        vscode.window.showErrorMessage(
          "Repository manager is not initialized."
        );
        return;
      }

      const statusResult = this.repositoryManager.getRepositorySummary();
      if (statusResult.isFailure()) {
        vscode.window.showErrorMessage(
          `Failed to get repository status: ${statusResult.error.message}`
        );
        return;
      }

      const status = statusResult.value;

      const details = [
        `Total repositories: ${status.totalRepositories}`,
        `Tracked repositories: ${status.trackedRepositories}`,
        `Repositories with changes: ${status.repositoriesWithChanges}`,
      ];

      if (status.activeRepository) {
        details.push(`Active repository: ${status.activeRepository}`);
      }

      vscode.window.showInformationMessage("Repository Status", ...details);

      // Update the status bar with a temporary message
      this.statusManager.showTemporaryMessage(
        `${status.trackedRepositories} repos tracked`,
        "repo",
        5000
      );
    } catch (error) {
      this.logService.error("Error showing repository status", error);
      vscode.window.showErrorMessage(
        `Failed to show repository status: ${error}`
      );
    }
  }

  /**
   * Disposes of all registered commands
   */
  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Creates a terminal to execute Git operations
   * @param workingDirectory The directory to execute commands in
   * @param scriptContent The script content to execute
   * @param terminalName Optional custom terminal name
   * @returns The created terminal
   */
  public createGitOperationTerminal(
    workingDirectory: string,
    scriptContent: string,
    terminalName: string = "Commit Tracker"
  ): vscode.Terminal {
    this.logService.info(
      `Creating Git operation terminal for: ${workingDirectory}`
    );

    // Create temporary script file
    const scriptPath = path.join(os.tmpdir(), `git-operation-${Date.now()}.sh`);

    try {
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

      // Create and configure terminal
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        hideFromUser: false,
        location: vscode.TerminalLocation.Panel,
        isTransient: true,
      });

      terminal.show(false);
      terminal.sendText(`bash "${scriptPath}" && exit || exit`);

      // Clean up script after delay
      setTimeout(() => {
        try {
          fs.unlinkSync(scriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }, 10000);

      return terminal;
    } catch (error) {
      this.logService.error(
        `Failed to create Git operation terminal: ${error}`
      );
      throw new Error(`Failed to create Git operation terminal: ${error}`);
    }
  }
}
