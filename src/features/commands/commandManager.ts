import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GitService } from "../../services/gitService";
import { SetupManager } from "../setup/setupManager";
import { StatusManager } from "../status/statusManager";
import {
  RepositoryEvent,
  RepositoryManager,
} from "../repository/repositoryManager";
import { ILogService } from "../../services/interfaces/ILogService";
import { IFileSystemService } from "../../services/interfaces/IFileSystemService";
import { INotificationService } from "../../services/interfaces/INotificationService";

/**
 * Manages all extension commands and their registration
 */
export class CommandManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly gitService: GitService;
  private readonly logService: ILogService;
  private readonly setupManager: SetupManager;
  private readonly statusManager: StatusManager;
  private readonly repositoryManager: RepositoryManager;
  private fileSystemService?: IFileSystemService;
  private notificationService?: INotificationService;
  private disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    gitService: GitService,
    logService: ILogService,
    setupManager: SetupManager,
    statusManager: StatusManager,
    repositoryManager: RepositoryManager,
    fileSystemService?: IFileSystemService,
    notificationService?: INotificationService
  ) {
    this.context = context;
    this.gitService = gitService;
    this.logService = logService;
    this.setupManager = setupManager;
    this.statusManager = statusManager;
    this.repositoryManager = repositoryManager;
    this.fileSystemService = fileSystemService;
    this.notificationService = notificationService;

    // Log if FileSystemService is available
    if (this.fileSystemService) {
      // Use notificationService if available, otherwise fallback to direct vscode API
      if (this.notificationService) {
        this.logService.debug("FileSystemService available to CommandManager");
      } else {
        this.logService.debug("FileSystemService available to CommandManager");
      }
    } else {
      if (this.notificationService) {
        this.logService.warn(
          "FileSystemService not available to CommandManager"
        );
      } else {
        this.logService.warn(
          "FileSystemService not available to CommandManager"
        );
      }
    }
  }

  public setupRepositoryEventListeners(): void {
    if (this.repositoryManager) {
      // Push requests from RepositoryManager
      this.repositoryManager.on(
        RepositoryEvent.PUSH_REQUESTED,
        this.handlePushRequest.bind(this)
      );

      // Terminal operations requested by RepositoryManager
      this.repositoryManager.on(
        RepositoryEvent.TERMINAL_OPERATION_REQUESTED,
        (workingDirectory: string, command: string, terminalName: string) => {
          this.createGitOperationTerminal(
            workingDirectory,
            command,
            terminalName
          );
        }
      );

      // Setup requests from RepositoryManager
      this.repositoryManager.on(RepositoryEvent.SETUP_REQUESTED, async () => {
        await this.setupTracker();
      });

      // Repository state requests
      this.repositoryManager.on(
        RepositoryEvent.REPOSITORY_INFO_REQUESTED,
        () => {
          this.showRepositoryStatus();
        }
      );

      // Error handling
      this.repositoryManager.on(RepositoryEvent.ERROR, (error, operation) => {
        this.logService.error(
          `Repository error in operation ${operation}: ${error}`
        );

        // Show error in notification based on error type
        if (operation === "git" || operation === "push") {
          vscode.window.showErrorMessage(`Git operation failed: ${error}`);
        } else if (operation === "fileSystem") {
          vscode.window.showErrorMessage(`File operation failed: ${error}`);
        } else {
          vscode.window.showErrorMessage(
            `Repository operation failed: ${error}`
          );
        }
      });

      // Listen for specific error types to provide contextual UI feedback
      this.repositoryManager.on(
        RepositoryEvent.ERROR_GIT_OPERATION,
        (error) => {
          vscode.window
            .showErrorMessage(`Git error: ${error}`, "Check Git Status")
            .then((selection) => {
              if (selection === "Check Git Status") {
                this.showRepositoryStatus();
              }
            });
        }
      );
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
      // Replace direct vscode call with notificationService
      if (this.notificationService) {
        this.notificationService.info(
          "Commit Tracker setup completed successfully!"
        );
      } else {
        vscode.window.showInformationMessage(
          "Commit Tracker setup completed successfully!"
        );
      }
    }
  }

  /**
   * Command handler: Reset setup
   */
  private async resetSetup(): Promise<void> {
    await this.setupManager.resetSetup();

    // Replace direct vscode call with notificationService
    if (this.notificationService) {
      this.notificationService.info(
        "Commit Tracker setup has been reset. Run the Setup Tracking Repository command to reconfigure."
      );
    } else {
      vscode.window.showInformationMessage(
        "Commit Tracker setup has been reset. Run the Setup Tracking Repository command to reconfigure."
      );
    }

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
      if (!gitExtension) {
        if (this.notificationService) {
          this.notificationService.error("Git extension not found");
        } else {
          vscode.window.showErrorMessage("Git extension not found");
        }
        this.statusManager.setErrorStatus("Git Not Found");
        return;
      }

      const api = gitExtension.getAPI(1);
      if (!api) {
        if (this.notificationService) {
          this.notificationService.error("Git API not available");
        } else {
          vscode.window.showErrorMessage("Git API not available");
        }
        this.statusManager.setErrorStatus("Git API Error");
        return;
      }

      const repo = api.repositories[0];
      if (!repo) {
        if (this.notificationService) {
          this.notificationService.warn("No repository found");
        } else {
          vscode.window.showWarningMessage("No repository found");
        }
        this.statusManager.setErrorStatus("No Repository");
        return;
      }

      const result = await this.repositoryManager.processCurrentRepository(
        repo
      );

      if (result.isSuccess()) {
        const commit = result.value;
        this.statusManager.showCommitProcessedStatus(
          commit.repoName,
          commit.hash.substring(0, 7)
        );
        if (this.notificationService) {
          this.notificationService.info(
            `Commit logged: ${commit.hash.substring(0, 7)}`,
            {
              detail: commit.message,
            }
          );
        } else {
          vscode.window.showInformationMessage(
            `Commit logged: ${commit.hash.substring(0, 7)}`
          );
        }
      } else {
        this.statusManager.showCommitFailedStatus(result.error);
        if (this.notificationService) {
          this.notificationService.error("Failed to log commit", {
            detail: result.error.message,
          });
        } else {
          vscode.window.showErrorMessage(
            `Failed to log commit: ${result.error.message}`
          );
        }
      }
    } catch (error) {
      this.statusManager.showCommitFailedStatus(
        error instanceof Error ? error : new Error(String(error))
      );
      if (this.notificationService) {
        this.notificationService.error("Error logging commit", {
          detail: String(error),
        });
      } else {
        vscode.window.showErrorMessage(`Error logging commit: ${error}`);
      }
    }
  }

  /**
   * Command handler: Start monitoring
   */
  private async startMonitoring(): Promise<void> {
    if (this.repositoryManager) {
      const initResult = await this.repositoryManager.initialize();
      if (initResult.isSuccess()) {
        if (this.notificationService) {
          this.notificationService.info("Commit monitoring started");
        } else {
          vscode.window.showInformationMessage("Commit monitoring started");
        }
      } else {
        if (this.notificationService) {
          this.notificationService.error("Failed to start commit monitoring", {
            detail: initResult.error.message,
          });
        } else {
          vscode.window.showErrorMessage(
            `Failed to start commit monitoring: ${initResult.error.message}`
          );
        }
      }
    } else {
      if (this.notificationService) {
        this.notificationService.error("Repository manager not available");
      } else {
        vscode.window.showErrorMessage("Repository manager not available");
      }
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

      if (!gitExtension) {
        if (this.notificationService) {
          this.notificationService.error("Git extension not found");
        } else {
          vscode.window.showErrorMessage("Git extension not found");
        }
        return;
      }

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
    } catch (error) {
      if (this.notificationService) {
        this.notificationService.error("Error force logging commit", {
          detail: String(error),
        });
      } else {
        vscode.window.showErrorMessage(`Error force logging commit: ${error}`);
      }
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
      if (this.notificationService) {
        this.notificationService.info("Pushing tracker changes...");
      } else {
        vscode.window.showInformationMessage("Pushing tracker changes...");
      }

      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath");
      const logFile = config.get<string>("logFile", "commit-tracker.log");

      if (!logFilePath) {
        if (this.notificationService) {
          this.notificationService.error("Log file path not configured");
        } else {
          vscode.window.showErrorMessage("Log file path not configured");
        }
        return;
      }

      const trackingFilePath = path.join(logFilePath, logFile);

      // Dispatch to repository manager which will then request a terminal from CommandManager
      this.repositoryManager.requestPush(logFilePath, trackingFilePath);
    } catch (error) {
      this.logService.error(`Failed to push changes: ${error}`);
      if (this.notificationService) {
        this.notificationService.error("Failed to push changes", {
          detail: String(error),
        });
      } else {
        vscode.window.showErrorMessage(`Failed to push changes: ${error}`);
      }
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
      this.statusManager.updateLoggingStatus(true);
      if (this.notificationService) {
        this.notificationService.info("Debug logging enabled");
      } else {
        vscode.window.showInformationMessage("Debug logging enabled");
      }
      this.logService.showOutput(true);
    } else {
      this.statusManager.updateLoggingStatus(false);
      if (this.notificationService) {
        this.notificationService.info("Debug logging disabled");
      } else {
        vscode.window.showInformationMessage("Debug logging disabled");
      }
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
   * Creates a terminal to execute Git operations safely
   * @param workingDirectory The directory to execute commands in
   * @param scriptContent The script content to execute
   * @param terminalName Optional custom terminal name
   * @returns The created terminal
   */
  public async createGitOperationTerminal(
    workingDirectory: string,
    scriptContent: string,
    terminalName: string = "Commit Tracker"
  ): Promise<vscode.Terminal | undefined> {
    this.logService.info(
      `Creating Git operation terminal for: ${workingDirectory}`
    );

    if (!this.fileSystemService) {
      if (this.notificationService) {
        this.notificationService.error("FileSystemService not available", {
          detail: "Cannot create Git operation terminal",
        });
      } else {
        vscode.window.showErrorMessage(
          "FileSystemService not available. Cannot create Git operation terminal."
        );
      }
      return undefined;
    }

    try {
      // Use the new safe temp file handling
      const scriptResult =
        await this.fileSystemService.createTempFileWithCleanup(scriptContent, {
          prefix: "commit-tracker-terminal-",
          suffix: ".sh",
        });

      if (scriptResult.isFailure()) {
        this.logService.error(
          `Failed to create temporary script: ${scriptResult.error}`
        );
        return undefined;
      }

      const scriptPath = scriptResult.value.path;

      // Create terminal
      const terminal = vscode.window.createTerminal({
        name: terminalName,
        cwd: workingDirectory,
      });

      terminal.show();
      terminal.sendText(`bash "${scriptPath}" && exit || exit`);

      // The script file will be cleaned up automatically when the process exits

      return terminal;
    } catch (error) {
      this.logService.error(
        `Failed to create Git operation terminal: ${error}`
      );
      if (this.notificationService) {
        this.notificationService.error(
          "Failed to create Git operation terminal",
          {
            detail: String(error),
          }
        );
      } else {
        vscode.window.showErrorMessage(
          `Failed to create Git operation terminal: ${error}`
        );
      }
      return undefined;
    }
  }

  /**
   * Command handler: Handle push request
   */
  private async handlePushRequest(
    logFilePath: string,
    trackingFilePath: string
  ): Promise<void> {
    try {
      if (!this.fileSystemService) {
        if (this.notificationService) {
          this.notificationService.error("File system service not available");
        } else {
          vscode.window.showErrorMessage("File system service not available");
        }
        return;
      }

      this.logService.info(`Push request received for ${trackingFilePath}`);
      this.statusManager.showPushingStatus();

      // Show notification when done
      if (this.notificationService) {
        this.notificationService.info("Push operation started in terminal");
      } else {
        vscode.window.showInformationMessage(
          "Push operation started in terminal"
        );
      }

      // Verify paths exist
      const logPathExists = await this.fileSystemService.exists(logFilePath);
      if (logPathExists.isFailure() || !logPathExists.value) {
        throw new Error(`Log directory does not exist: ${logFilePath}`);
      }

      const trackingFileExists = await this.fileSystemService.exists(
        trackingFilePath
      );
      if (trackingFileExists.isFailure() || !trackingFileExists.value) {
        throw new Error(`Tracking file does not exist: ${trackingFilePath}`);
      }

      // Create script content
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

      // Create terminal and run script
      const terminal = await this.createGitOperationTerminal(
        logFilePath,
        scriptContent,
        "Commit Tracker Push"
      );

      if (!terminal) {
        throw new Error("Failed to create terminal");
      }

      // Update status bar with a delayed refresh
      setTimeout(() => {
        this.statusManager.refresh();
      }, 7000);

      this.logService.info("Push operation started in terminal");
    } catch (error) {
      this.logService.error(`Error in handlePushRequest: ${error}`);
      this.statusManager.showPushFailedStatus();
      if (this.notificationService) {
        this.notificationService.error("Failed to create push operation", {
          detail: String(error),
        });
      } else {
        vscode.window.showErrorMessage(
          `Failed to create push operation: ${error}`
        );
      }
    }
  }
}
