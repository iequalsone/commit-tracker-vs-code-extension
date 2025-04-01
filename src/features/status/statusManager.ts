import * as vscode from "vscode";
import { GitService } from "../../services/gitService";
import { LogService } from "../../services/logService";
import {
  RepositoryManager,
  RepositoryEvent,
  StatusUpdate,
} from "../repository/repositoryManager";
import path from "path";
import { IStatusManager } from "./statusManagerInterface";
import { IConfigurationService } from "../../services/interfaces/IConfigurationService";
import {
  INotificationService,
  NotificationPriority,
} from "../../services/interfaces/INotificationService";

/**
 * Manages the status bar item and displays current tracking state
 */
export class StatusManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private readonly context: vscode.ExtensionContext;
  private readonly gitService: GitService;
  private readonly logService: LogService;
  private readonly configurationService?: IConfigurationService;
  private readonly notificationService?: INotificationService;
  private updateInterval: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    gitService: GitService,
    logService: LogService,
    repositoryManager?: RepositoryManager,
    configurationService?: IConfigurationService,
    notificationService?: INotificationService
  ) {
    this.context = context;
    this.gitService = gitService;
    this.logService = logService;
    this.configurationService = configurationService;
    this.notificationService = notificationService;

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = "commitTracker.showDetails";

    // Connect to repository manager events if provided
    if (repositoryManager) {
      this.connectToRepositoryManager(repositoryManager);
    }

    // Listen for configuration changes if service is provided
    if (configurationService) {
      this.registerConfigurationListeners(configurationService);
    }
  }

  /**
   * Register configuration change listeners
   * @param configService The configuration service
   */
  private registerConfigurationListeners(
    configService: IConfigurationService
  ): void {
    this.logService.info(
      "Registering configuration listeners for StatusManager"
    );

    // Listen for update frequency changes
    this.disposables.push(
      configService.onDidChangeConfigurationValue<number>(
        "updateFrequencyMinutes",
        (newValue) => {
          this.logService.info(
            `Update frequency changed to ${newValue} minutes`
          );
          this.startStatusUpdateInterval();
        }
      )
    );

    // Listen for enabled state changes
    this.disposables.push(
      configService.onDidChangeConfigurationValue<boolean>(
        "enabled",
        (newValue) => {
          if (newValue) {
            this.setTrackingStatus();
          } else {
            this.setStoppedStatus();
          }
        }
      )
    );
  }

  /**
   * Connect to the repository manager's events
   * @param repositoryManager The repository manager to connect to
   */
  public connectToRepositoryManager(
    repositoryManager: RepositoryManager
  ): void {
    this.logService.info(
      "Connecting StatusManager to RepositoryManager events"
    );

    // Add this new event listener
    repositoryManager.on(
      RepositoryEvent.STATUS_UPDATE,
      (update: StatusUpdate) => {
        switch (update.type) {
          case "normal":
            this.setTrackingStatus();
            break;
          case "error":
            this.setErrorStatus(update.message);
            setTimeout(() => this.setTrackingStatus(), 5000);
            break;
          case "warning":
            this.showTemporaryMessage(
              update.message,
              "warning",
              update.duration || 3000
            );
            break;
          case "info":
            this.showTemporaryMessage(
              update.message,
              "info",
              update.duration || 3000
            );
            break;
          case "processing":
            this.setProcessingStatus(update.message);
            break;
        }
      }
    );

    repositoryManager.on(RepositoryEvent.TRACKING_STARTED, () => {
      this.setTrackingStatus();
    });

    repositoryManager.on(RepositoryEvent.TRACKING_STOPPED, () => {
      this.setStatus("$(circle-slash) CT: Stopped", "Commit tracking stopped");
    });

    repositoryManager.on(
      RepositoryEvent.COMMIT_DETECTED,
      (repo, commitHash) => {
        const repoName = path.basename(repo.rootUri?.fsPath || "unknown");
        this.showCommitDetectedStatus(repoName);
      }
    );

    repositoryManager.on(RepositoryEvent.COMMIT_PROCESSED, (commit) => {
      if (commit && commit.repoName) {
        this.showCommitProcessedStatus(commit.repoName, commit.hash);
      }
    });

    repositoryManager.on(
      RepositoryEvent.COMMIT_FAILED,
      (repo, commitHash, error) => {
        this.showCommitFailedStatus(error);
      }
    );

    repositoryManager.on(RepositoryEvent.ERROR, (error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.setErrorStatus(errorMessage.substring(0, 20) + "...");
      // Reset status after a timeout
      setTimeout(() => this.setTrackingStatus(), 5000);
    });

    repositoryManager.on(
      RepositoryEvent.UNPUSHED_COMMITS_CHANGED,
      (hasUnpushed) => {
        this.updateUnpushedIndicator(hasUnpushed);
      }
    );

    this.logService.info("Successfully connected to RepositoryManager events");

    // Connect to specific error events
    repositoryManager.on(RepositoryEvent.ERROR_GIT_OPERATION, () => {
      this.setErrorStatus("Git Error");
      setTimeout(() => this.setTrackingStatus(), 5000);
    });

    repositoryManager.on(RepositoryEvent.ERROR_CONFIGURATION, () => {
      this.setErrorStatus("Config Error");
    });

    repositoryManager.on(RepositoryEvent.ERROR_FILESYSTEM, () => {
      this.setErrorStatus("File Error");
      setTimeout(() => this.setTrackingStatus(), 5000);
    });

    repositoryManager.on(RepositoryEvent.ERROR_REPOSITORY, () => {
      this.setErrorStatus("Repo Error");
      setTimeout(() => this.setTrackingStatus(), 5000);
    });
  }

  /**
   * Updates the status bar to indicate unpushed commits
   * @param hasUnpushed Whether there are unpushed commits
   */
  public updateUnpushedIndicator(hasUnpushed: boolean): void {
    if (hasUnpushed) {
      this.showUnpushedCommitsStatus();
    } else {
      this.showNormalStatus();
    }
  }

  /**
   * Initializes the status bar item
   */
  public initialize(): void {
    this.logService.info("Initializing status bar");
    this.statusBarItem.command = "commitTracker.showDetails";
    this.statusBarItem.text = "$(git-commit) Commit Tracker";
    this.statusBarItem.tooltip = "Commit Tracker";
    this.statusBarItem.show();

    // Update immediately
    this.updateStatus();

    // Set up regular updates
    this.startStatusUpdateInterval();

    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("commitTracker.updateFrequencyMinutes")) {
        this.startStatusUpdateInterval();
      }
    }, this);
  }

  /**
   * Updates the status bar with current information
   */
  public async updateStatus(): Promise<void> {
    try {
      this.statusBarItem.text = "$(sync~spin) Updating...";

      // Check if tracking repository has unpushed commits
      const hasUnpushedCommits = await this.gitService.hasUnpushedCommits();

      // Check if there are any errors with the tracking repository
      const trackerRepoPath = vscode.workspace
        .getConfiguration("commitTracker")
        .get<string>("logFilePath");

      if (!trackerRepoPath) {
        this.showSetupNeededStatus();
        return;
      }

      if (hasUnpushedCommits) {
        this.showUnpushedCommitsStatus();
      } else {
        this.showNormalStatus();
      }
    } catch (error) {
      this.logService.error("Error updating status", error);
      this.showErrorStatus();
    }
  }

  /**
   * Shows status for normal operation (no unpushed commits)
   */
  private showNormalStatus(): void {
    this.statusBarItem.text = "$(git-commit) Commits tracked";
    this.statusBarItem.tooltip = "All commits are pushed";
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.command = "commitTracker.showDetails";
  }

  /**
   * Shows status when unpushed commits exist
   */
  private showUnpushedCommitsStatus(): void {
    this.statusBarItem.text = "$(warning) Unpushed commits";
    this.statusBarItem.tooltip = "You have unpushed commits";
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.statusBarItem.command = "commitTracker.pushTrackerChanges";
  }

  /**
   * Shows error status when something goes wrong
   */
  private showErrorStatus(): void {
    this.statusBarItem.text = "$(error) Commit tracker error";
    this.statusBarItem.tooltip = "Error tracking commits";
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.statusBarItem.command = "commitTracker.showDebugInfo";
  }

  /**
   * Shows status when setup is needed
   */
  private showSetupNeededStatus(): void {
    this.statusBarItem.text = "$(warning) Setup needed";
    this.statusBarItem.tooltip = "Commit Tracker needs to be configured";
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.statusBarItem.command = "commitTracker.setupTracker";
  }

  /**
   * Sets up a periodic update interval for the status
   */
  public startStatusUpdateInterval(): void {
    // Clear any existing interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    // Get update frequency from settings (default 5 minutes)
    const updateFrequencyMinutes = vscode.workspace
      .getConfiguration("commitTracker")
      .get("updateFrequencyMinutes", 5);

    this.logService.info(
      `Setting status update interval to ${updateFrequencyMinutes} minutes`
    );

    // Set up new interval (convert to milliseconds)
    this.updateInterval = setInterval(
      () => this.updateStatus(),
      updateFrequencyMinutes * 60 * 1000
    );
  }

  /**
   * Forces an immediate status update
   * @returns Promise that resolves when the update is complete
   */
  public async forceUpdate(): Promise<void> {
    return this.updateStatus();
  }

  /**
   * Updates status bar to show custom message temporarily
   * @param message The message to show
   * @param icon Optional icon to show (VS Code codicon)
   * @param durationMs How long to show message (default: 3000ms)
   */
  public showTemporaryMessage(
    message: string,
    icon = "info",
    durationMs = 3000
  ): void {
    // Store original text and tooltip
    const originalText = this.statusBarItem.text;
    const originalTooltip = this.statusBarItem.tooltip;

    // Show temporary message
    this.statusBarItem.text = `$(${icon}) ${message}`;

    // Reset after duration
    setTimeout(() => {
      // Only reset if it hasn't been changed elsewhere
      if (this.statusBarItem.text === `$(${icon}) ${message}`) {
        this.statusBarItem.text = originalText;
        this.statusBarItem.tooltip = originalTooltip;
      }
    }, durationMs);
  }

  /**
   * Disposes of the status bar item and clears any intervals
   */
  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.statusBarItem.dispose();
  }

  /**
   * Sets the status bar to show normal tracking status
   */
  public setTrackingStatus(): void {
    this.showNormalStatus();
  }

  /**
   * Sets the status bar to show stopped tracking status
   */
  public setStoppedStatus(): void {
    this.setStatus("$(circle-slash) CT: Stopped", "Commit tracking stopped");
  }

  /**
   * Sets the status bar to show an error state
   * @param reason Optional text indicating the reason for the error
   */
  public setErrorStatus(reason?: string): void {
    this.statusBarItem.text = `$(error) ${reason || "Error"}`;
    this.statusBarItem.tooltip = `Error: ${reason || "Check logs for details"}`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.statusBarItem.command = "commitTracker.showDebugInfo";
  }

  /**
   * Sets the status bar to show a processing state
   * @param message Optional message to show during processing
   */
  public setProcessingStatus(message: string = "Processing..."): void {
    this.statusBarItem.text = `$(sync~spin) ${message}`;
    this.statusBarItem.tooltip = "Commit Tracker is processing";
    this.statusBarItem.backgroundColor = undefined;
  }

  /**
   * Sets the status bar to show setup needed status
   */
  public setSetupNeededStatus(): void {
    this.showSetupNeededStatus();
  }

  /**
   * Refreshes the status bar (manual trigger)
   */
  public refresh(): void {
    this.forceUpdate();
  }

  /**
   * Updates the status to show unpushed commits status if needed
   */
  public async updateUnpushedStatus(): Promise<void> {
    try {
      // Check if tracking repository has unpushed commits
      const hasUnpushedCommits = await this.gitService.hasUnpushedCommits();

      if (hasUnpushedCommits) {
        this.showUnpushedCommitsStatus();
      } else {
        this.showNormalStatus();
      }
    } catch (error) {
      this.logService.error("Error updating unpushed status", error);
    }
  }

  /**
   * Updates the status bar to reflect current logging state
   * @param enabled Whether logging is enabled
   */
  public updateLoggingStatus(enabled: boolean): void {
    const currentText = this.statusBarItem.text;
    if (enabled && !currentText.includes("$(output)")) {
      this.statusBarItem.text = `${currentText} $(output)`;
    } else if (!enabled && currentText.includes("$(output)")) {
      this.statusBarItem.text = currentText.replace(" $(output)", "");
    }
  }

  /**
   * Shows status for a repository commit detection event
   * @param repoName The name of the repository
   */
  public showCommitDetectedStatus(repoName: string): void {
    this.showTemporaryMessage(`Commit detected in ${repoName}`, "git-commit");

    // Use notification service if available, otherwise fall back to direct VS Code API
    if (this.notificationService) {
      this.notificationService.info(
        `New commit detected in repository: ${repoName}`,
        {
          useMarkdown: true,
          priority: NotificationPriority.NORMAL,
        }
      );
    } else {
      vscode.window.showInformationMessage(
        `New commit detected in repository: ${repoName}`
      );
    }
  }

  /**
   * Shows status for a commit being processed
   * @param repoName The name of the repository
   * @param hash The commit hash (shortened)
   */
  public showCommitProcessingStatus(repoName: string, hash: string): void {
    this.showTemporaryMessage(
      `Processing commit ${hash.substring(0, 7)} in ${repoName}`,
      "loading~spin"
    );
  }

  /**
   * Shows success status for a processed commit
   * @param repoName The name of the repository
   * @param hash The commit hash (shortened)
   */
  public showCommitProcessedStatus(repoName: string, hash: string): void {
    this.showTemporaryMessage(
      `Commit ${hash.substring(0, 7)} processed`,
      "check"
    );

    if (this.notificationService) {
      this.notificationService.info(
        `Successfully processed commit ${hash.substring(0, 7)} in ${repoName}`,
        {
          useMarkdown: true,
          priority: NotificationPriority.NORMAL,
        }
      );
    } else {
      vscode.window.showInformationMessage(
        `Successfully processed commit ${hash.substring(0, 7)} in ${repoName}`
      );
    }
  }

  /**
   * Shows failure status for a failed commit process
   * @param error Error message or object
   */
  public showCommitFailedStatus(error: Error | string): void {
    const errorMessage = typeof error === "string" ? error : error.message;

    this.showTemporaryMessage(
      `Failed to process commit: ${errorMessage}`,
      "error"
    );

    if (this.notificationService) {
      this.notificationService.error(`Failed to process commit`, {
        detail: errorMessage,
        priority: NotificationPriority.HIGH,
        modal: false,
      });
    } else {
      vscode.window.showErrorMessage(
        `Failed to process commit: ${errorMessage}`
      );
    }
  }

  /**
   * Shows a Git extension not found status
   */
  public showGitNotFoundStatus(): void {
    this.setStatus(
      "$(error) Git Not Found",
      "Git extension is not available. Please ensure Git is installed."
    );

    if (this.notificationService) {
      this.notificationService
        .error(
          "Git extension is not available",
          {
            detail:
              "Please ensure Git is installed and the Git extension is enabled.",
            priority: NotificationPriority.HIGH,
          },
          "Open Settings"
        )
        .then((action) => {
          if (action === "Open Settings") {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "git"
            );
          }
        });
    } else {
      vscode.window
        .showErrorMessage(
          "Git extension is not available. Please ensure Git is installed and the Git extension is enabled.",
          "Open Settings"
        )
        .then((action) => {
          if (action === "Open Settings") {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "git"
            );
          }
        });
    }
  }

  /**
   * Shows a no repositories status
   */
  public showNoRepositoriesStatus(): void {
    this.setStatus(
      "$(info) No Git Repositories",
      "No Git repositories found in workspace"
    );

    if (this.notificationService) {
      this.notificationService.info("No Git repositories found in workspace", {
        detail:
          "Open a folder containing a Git repository to use Commit Tracker.",
        priority: NotificationPriority.NORMAL,
      });
    } else {
      vscode.window.showInformationMessage(
        "No Git repositories found in workspace. Open a folder containing a Git repository to use Commit Tracker."
      );
    }
  }

  /**
   * Shows push in progress status
   */
  public showPushingStatus(): void {
    this.setStatus(
      "$(sync~spin) Pushing...",
      "Pushing changes to remote repository"
    );
  }

  /**
   * Shows push failure status
   */
  public showPushFailedStatus(): void {
    this.setStatus(
      "$(warning) Push Failed",
      "Failed to push changes to remote repository"
    );

    if (this.notificationService) {
      this.notificationService
        .error(
          "Failed to push changes to remote repository",
          {
            detail:
              "There was an error pushing changes. Check the output panel for more details.",
            priority: NotificationPriority.HIGH,
          },
          "Show Details"
        )
        .then((action) => {
          if (action === "Show Details") {
            // Show the output channel with logs
            this.logService.showOutput(true);
          }
        });
    } else {
      vscode.window
        .showErrorMessage(
          "Failed to push changes to remote repository. There was an error pushing changes.",
          "Show Details"
        )
        .then((action) => {
          if (action === "Show Details") {
            this.logService.showOutput(true);
          }
        });
    }
  }

  /**
   * Sets the status bar with custom text and tooltip
   * @param text The text to display in the status bar
   * @param tooltip The tooltip text
   */
  public setStatus(text: string, tooltip: string): void {
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.show();
  }
}
