import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GitService } from "../../services/gitService";
import { debounce } from "../../utils/debounce";
import { DisposableManager } from "../../utils/DisposableManager";
import { Result, success, failure } from "../../utils/results";
import { EventEmitter } from "events";
import { CommandManager } from "../commands/commandManager";

import { StatusManager } from "../status/statusManager";
import {
  ErrorHandlingService,
  ErrorType,
} from "../../services/errorHandlingService";
import { ILogService } from "../../services/interfaces/ILogService";
import { IConfigurationService } from "../../services/interfaces/IConfigurationService";
import {
  FileWatcher,
  IFileSystemService,
} from "../../services/interfaces/IFileSystemService";
import {
  INotificationService,
  NotificationPriority,
} from "../../services/interfaces/INotificationService";

/**
 * Repository status information
 */
export interface RepositoryStatus {
  repoPath: string;
  currentCommit: string | undefined;
  branchName: string | undefined;
  hasChanges: boolean;
  repoName: string;
}

/**
 * Represents a Git commit
 */
export interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
  branch: string;
  repoName: string;
  repoPath: string;
}

/**
 * Interface for status updates that can be sent to StatusManager
 */
export interface StatusUpdate {
  type: "normal" | "error" | "warning" | "info" | "processing";
  message: string;
  details?: string;
  duration?: number; // Duration in ms for temporary messages
  data?: any; // Additional data related to the status
}

/**
 * Events emitted by the RepositoryManager
 */
export enum RepositoryEvent {
  TRACKING_STARTED = "tracking-started",
  TRACKING_STOPPED = "tracking-stopped",
  COMMIT_DETECTED = "commit-detected",
  COMMIT_PROCESSED = "commit-processed",
  COMMIT_FAILED = "commit-failed",
  REPOSITORY_CHANGED = "repository-changed",
  ERROR = "error",
  ERROR_CONFIGURATION = "error-configuration",
  ERROR_GIT_OPERATION = "error-git-operation",
  ERROR_FILESYSTEM = "error-filesystem",
  ERROR_REPOSITORY = "error-repository",
  PUSH_REQUESTED = "push-requested",
  CONFIG_UPDATED = "config-updated",
  REPOSITORY_STATUS_CHANGED = "repository-status-changed",
  UNPUSHED_COMMITS_CHANGED = "unpushed-commits-changed",
  CACHE_INVALIDATED = "cache-invalidated",
  STATISTICS_UPDATED = "statistics-updated",
  COMMIT_HISTORY_UPDATED = "commit-history-updated",
  STATUS_UPDATE = "status-update",
  TERMINAL_OPERATION_REQUESTED = "terminal-operation-requested",
  SETUP_REQUESTED = "setup-requested",
  REPOSITORY_INFO_REQUESTED = "repository-info-requested",
  REPOSITORY_INITIALIZED = "repository-initialized",
}

export class RepositoryManager extends EventEmitter {
  private disposableManager: DisposableManager;
  private logFilePath: string = "";
  private logFile: string = "";
  private excludedBranches: string[] = [];
  private context: vscode.ExtensionContext;
  private lastProcessedCommit: string | null;
  private repoListeners: Map<string, vscode.Disposable> = new Map();
  private repositories: Map<string, RepositoryStatus> = new Map();
  private statusManager: StatusManager | undefined;
  private commandManager: CommandManager | undefined;
  private errorHandlingService: ErrorHandlingService;
  private gitService: GitService | undefined;
  private configurationService?: IConfigurationService;
  private logService?: ILogService;
  private fileSystemService?: IFileSystemService;
  private notificationService?: INotificationService;
  private _configChangeDisposable?: vscode.Disposable;

  private cache: {
    repositoryStatus: Map<
      string,
      {
        data: RepositoryStatus;
        timestamp: number;
      }
    >;
    commitHistory: {
      data: Commit[];
      timestamp: number;
    } | null;
    statistics: {
      data: {
        totalCommits: number;
        commitsByRepo: Record<string, number>;
        commitsByAuthor: Record<string, number>;
        commitsByBranch: Record<string, number>;
        lastCommitDate: Date | null;
      };
      timestamp: number;
    } | null;
    unpushedCommits: {
      data: {
        count: number;
        commitHashes: string[];
        needsPush: boolean;
      };
      timestamp: number;
    } | null;
  } = {
    repositoryStatus: new Map(),
    commitHistory: null,
    statistics: null,
    unpushedCommits: null,
  };

  // Cache TTL values
  private readonly CACHE_TTL = {
    REPO_STATUS: 30 * 1000, // 30 seconds
    COMMIT_HISTORY: 60 * 1000, // 1 minute
    STATISTICS: 5 * 60 * 1000, // 5 minutes
    UNPUSHED_COMMITS: 30 * 1000, // 30 seconds
  };

  constructor(
    context: vscode.ExtensionContext,
    statusManager?: StatusManager,
    commandManager?: CommandManager,
    errorHandlingService?: ErrorHandlingService,
    gitService?: GitService,
    configurationService?: IConfigurationService,
    logService?: ILogService,
    fileSystemService?: IFileSystemService,
    notificationService?: INotificationService
  ) {
    super();
    this.context = context;
    this.statusManager = statusManager;
    this.commandManager = commandManager;
    this.gitService = gitService;
    this.configurationService = configurationService;
    this.logService = logService;
    this.fileSystemService = fileSystemService;
    this.notificationService = notificationService;
    this.disposableManager = DisposableManager.getInstance();
    this.lastProcessedCommit = context.globalState.get(
      "lastProcessedCommit",
      null
    );

    // Use logService if available
    if (this.logService) {
      this.logService.info("RepositoryManager initialized");
    }

    // Initialize cache
    this.cache = {
      repositoryStatus: new Map(),
      commitHistory: null,
      statistics: null,
      unpushedCommits: null,
    };

    // Store cache creation time
    if (!this.context.globalState.get("cacheCreated")) {
      this.context.globalState.update("cacheCreated", new Date());
    }

    // Use provided error handling service or create a basic one
    this.errorHandlingService =
      errorHandlingService ||
      ({
        handleError: (error, operation, type) => {
          const errorObj =
            error instanceof Error ? error : new Error(String(error));
          console.error(`[${type}] Error in ${operation}: ${errorObj.message}`);
          this.emit(RepositoryEvent.ERROR, errorObj, operation);
        },
      } as ErrorHandlingService);

    // Load configuration
    this.loadConfiguration();

    this.setupConfigChangeListener();

    // Set up event listeners to update status
    if (this.statusManager) {
      this.setupStatusManagerEvents();
    }
  }

  /**
   * Invalidate specific parts of the cache or the entire cache
   * @param cacheKey Optional specific cache key to invalidate
   */
  public invalidateCache(
    cacheKey?:
      | "repositoryStatus"
      | "commitHistory"
      | "statistics"
      | "unpushedCommits"
  ): void {
    if (cacheKey) {
      switch (cacheKey) {
        case "repositoryStatus":
          this.cache.repositoryStatus.clear();
          break;
        case "commitHistory":
          this.cache.commitHistory = null;
          break;
        case "statistics":
          this.cache.statistics = null;
          break;
        case "unpushedCommits":
          this.cache.unpushedCommits = null;
          break;
      }
    } else {
      // Clear all cache
      this.cache.repositoryStatus.clear();
      this.cache.commitHistory = null;
      this.cache.statistics = null;
      this.cache.unpushedCommits = null;
    }

    this.emit(RepositoryEvent.CACHE_INVALIDATED, cacheKey || "all");
  }

  /**
   * Enhanced centralized error handling for repository operations
   * Maps different error types to appropriate handlers and notifications
   *
   * @param error The error that occurred
   * @param operation Description of the operation that failed
   * @param errorType The specific type of error for targeted handling
   * @param showNotification Whether to show a notification to the user
   */
  private handleError(
    error: unknown,
    operation: string,
    errorType: ErrorType = ErrorType.UNKNOWN,
    showNotification: boolean = false
  ): void {
    // Map repository events to error types
    let suggestions: string[] = [];

    // Use logging service if available
    if (this.logService) {
      this.logService.error(`Error during ${operation}`, error);
    }

    // Add suggestions based on error type
    switch (errorType) {
      case ErrorType.CONFIGURATION:
        suggestions = ["Open Settings", "Run Setup Wizard"];
        break;
      case ErrorType.GIT_OPERATION:
        suggestions = ["Check Git Installation", "Open Terminal"];
        break;
      case ErrorType.FILESYSTEM:
        suggestions = ["Check Permissions", "Select New Location"];
        break;
      case ErrorType.REPOSITORY:
        suggestions = ["Refresh Status"];
        break;
    }

    // Use NotificationService for user-visible errors if requested
    if (showNotification && this.notificationService) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Create action array
      const actionTitles: string[] = [];

      if (errorType === ErrorType.CONFIGURATION) {
        actionTitles.push("Open Settings");
        actionTitles.push("Run Setup");
      } else if (errorType === ErrorType.GIT_OPERATION) {
        actionTitles.push("Open Terminal");
      } else if (errorType === ErrorType.FILESYSTEM) {
        actionTitles.push("Select New Location");
      } else if (errorType === ErrorType.REPOSITORY) {
        actionTitles.push("Refresh Status");
      }

      // Add View Logs action to all errors
      actionTitles.push("View Logs");

      // Show the error notification with callback
      this.notificationService.showWithCallback(
        `Error during ${operation}: ${errorMessage}`,
        "error",
        (action) => {
          if (action === "Open Settings") {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "commitTracker"
            );
          } else if (action === "Run Setup") {
            vscode.commands.executeCommand("commitTracker.setupTracker");
          } else if (action === "Open Terminal") {
            vscode.commands.executeCommand("workbench.action.terminal.new");
          } else if (action === "Select New Location") {
            vscode.commands.executeCommand("commitTracker.selectLogFolder");
          } else if (action === "Refresh Status") {
            vscode.commands.executeCommand("commitTracker.refreshStatus");
          } else if (action === "View Logs") {
            this.logService?.showOutput(true);
          }
        },
        {
          detail: `Error type: ${errorType}`,
        },
        ...actionTitles
      );
    }

    // Use the error handling service
    this.errorHandlingService.handleError(
      error,
      operation,
      errorType,
      false, // Don't show notification through error handling service since we're handling it here
      suggestions
    );

    // Always emit legacy events for backward compatibility
    const errorObj = error instanceof Error ? error : new Error(String(error));

    // Emit generic error event
    this.emit(RepositoryEvent.ERROR, errorObj, operation);

    // Also emit specific error event based on type
    switch (errorType) {
      case ErrorType.CONFIGURATION:
        this.emit(RepositoryEvent.ERROR_CONFIGURATION, errorObj);
        break;
      case ErrorType.GIT_OPERATION:
        this.emit(RepositoryEvent.ERROR_GIT_OPERATION, errorObj);
        break;
      case ErrorType.FILESYSTEM:
        this.emit(RepositoryEvent.ERROR_FILESYSTEM, errorObj);
        break;
      case ErrorType.REPOSITORY:
        this.emit(RepositoryEvent.ERROR_REPOSITORY, errorObj);
        break;
    }
  }

  /**
   * Connect to the command manager after initialization
   * @param commandManager The command manager instance
   */
  public connectCommandManager(commandManager: CommandManager): void {
    this.commandManager = commandManager;
  }

  /**
   * Set up event listeners to update status via StatusManager
   */
  private setupStatusManagerEvents(): void {
    if (!this.statusManager) {
      return;
    }

    // Listen for repository events
    this.on(RepositoryEvent.COMMIT_DETECTED, (repo, commitHash) => {
      const repoPath = repo.rootUri?.fsPath;
      const status = this.repositories.get(repoPath);
      if (status) {
        this.statusManager?.showCommitDetectedStatus(status.repoName);
      }
    });

    this.on(RepositoryEvent.COMMIT_PROCESSED, (commit, trackingFilePath) => {
      this.statusManager?.showCommitProcessedStatus(
        commit.repoName,
        commit.hash
      );
    });

    this.on(RepositoryEvent.COMMIT_FAILED, (repo, commitHash, error) => {
      this.statusManager?.showCommitFailedStatus(error);
    });

    this.on(RepositoryEvent.ERROR, (error) => {
      this.statusManager?.setErrorStatus(
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  /**
   * Initialize the repository manager and begin monitoring
   * @returns Result indicating success or failure
   */
  public async initialize(): Promise<Result<boolean, Error>> {
    try {
      this.logService?.info("Initializing repository manager");

      // Load configuration (should be done already but double-check)
      this.loadConfiguration();

      if (!this.fileSystemService) {
        return failure(new Error("File system service not initialized"));
      }

      // Validate tracking repository exists
      const dirExistsResult = await this.fileSystemService.exists(
        this.logFilePath
      );
      if (dirExistsResult.isFailure()) {
        return failure(dirExistsResult.error);
      }

      if (!dirExistsResult.value) {
        this.logService?.error(
          `Tracking directory does not exist: ${this.logFilePath}`
        );
        this.requestSetup();
        return failure(
          new Error(`Tracking directory does not exist: ${this.logFilePath}`)
        );
      }

      // Ensure log file directory exists
      const ensureDirResult = await this.fileSystemService.ensureDirectory(
        path.dirname(path.join(this.logFilePath, this.logFile))
      );
      if (ensureDirResult.isFailure()) {
        return failure(ensureDirResult.error);
      }

      // Pull changes if gitService is available
      if (this.gitService) {
        try {
          const pullResult = await this.gitService.pullChanges(
            this.logFilePath
          );
          if (pullResult.isFailure()) {
            this.logService?.warn(
              `Failed to pull changes from tracking repository: ${pullResult.error.message}`
            );
          } else {
            this.logService?.info(
              "Successfully pulled latest changes from tracking repository"
            );
          }
        } catch (err) {
          this.logService?.warn(
            `Failed to pull changes from tracking repository: ${err}`
          );
        }
      }

      // Find git extension
      const gitExtension =
        vscode.extensions.getExtension("vscode.git")?.exports;
      if (!gitExtension) {
        const error = new Error("Git extension not found");
        this.handleError(
          error,
          "initialize",
          ErrorType.EXTENSION_NOT_FOUND,
          true
        );
        return failure(error);
      }

      const api = gitExtension.getAPI(1);
      if (!api) {
        const error = new Error("Git API could not be initialized");
        this.handleError(
          error,
          "initialize",
          ErrorType.API_INITIALIZATION_FAILED,
          true
        );
        return failure(error);
      }

      this.logService?.info(
        "Git API available, setting up repository listeners"
      );

      // Set up monitoring
      const repoListenersResult = this.setupRepositoryListeners(api);
      if (repoListenersResult.isFailure()) {
        return failure(repoListenersResult.error);
      }

      const directMonitoringResult = this.setupDirectCommitMonitoring(api);
      if (directMonitoringResult.isFailure()) {
        return failure(directMonitoringResult.error);
      }

      // Process current repos immediately
      this.logService?.info("Processing current repository states");
      try {
        const repos = api.repositories;
        for (const repo of repos) {
          await this.updateRepositoryStatus(repo);
        }

        this.emit(RepositoryEvent.REPOSITORY_INITIALIZED, repos.length);
      } catch (error) {
        this.logService?.error(
          `Error processing current repositories: ${error}`
        );
      }

      // Check for unpushed commits
      await this.checkUnpushedCommits();

      // Set up log file watcher
      if (this.logFilePath && this.fileSystemService) {
        const watcherResult = await this.setupLogFileWatcher();
        if (watcherResult.isFailure()) {
          this.logService?.warn(
            `Could not set up log file watcher: ${watcherResult.error.message}`
          );
          // Continue anyway - watcher is not critical
        }
      }

      // Add repository git watchers
      this.setupRepositoryGitWatchers();

      return success(true);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logService?.error(
        `Failed to initialize repository manager: ${errorMsg}`,
        error
      );
      this.handleError(
        error,
        "initialize",
        ErrorType.INITIALIZATION_FAILED,
        true
      );
      return failure(
        new Error(`Failed to initialize repository manager: ${errorMsg}`)
      );
    }
  }

  /**
   * Connect to the status manager after initialization
   * @param statusManager The status manager instance
   */
  public connectStatusManager(statusManager: StatusManager): void {
    this.statusManager = statusManager;
    this.setupStatusManagerEvents();
  }

  /**
   * Process a specific commit from a repository
   */
  public async processCommit(
    repo: any,
    commitHash: string
  ): Promise<Result<Commit, Error>> {
    try {
      const repoStatus = await this.getRepositoryStatus(repo);
      if (repoStatus.isFailure()) {
        return failure(repoStatus.error);
      }

      let repoName = repoStatus.value.repoName;
      const repoPath = repo.rootUri?.fsPath;
      const branch = repo.state?.HEAD?.name || "unknown";

      // Show status update
      this.notifyCommitProcessing(repoName, commitHash);

      // Show processing status via status manager if available
      if (this.statusManager) {
        this.statusManager.showCommitProcessingStatus(repoName, commitHash);
      }

      // Skip excluded branches
      if (this.excludedBranches.includes(branch)) {
        return failure(new Error(`Skipping excluded branch: ${branch}`));
      }

      // Check if commit was already processed
      if (this.lastProcessedCommit === commitHash) {
        return failure(new Error(`Commit already processed: ${commitHash}`));
      }

      // Check if it's already in the log file
      try {
        if (!this.fileSystemService) {
          return failure(new Error("FileSystemService is not initialized"));
        }

        const logPath = path.join(this.logFilePath, this.logFile);
        const existsResult = await this.fileSystemService.exists(logPath);

        if (existsResult.isSuccess() && existsResult.value) {
          const readResult = await this.fileSystemService.readFile(logPath);
          if (readResult.isSuccess() && readResult.value.includes(commitHash)) {
            return failure(
              new Error(`Commit already in log file: ${commitHash}`)
            );
          }
        }
      } catch (error) {
        this.logService?.error(`Error checking log file: ${error}`);
      }

      // Get commit details
      let message = "No commit message";
      let author = "Unknown author";
      const commitDate = new Date().toISOString();

      if (this.gitService) {
        const messageResult = await this.gitService.getCommitMessage(
          repoPath,
          commitHash
        );
        if (messageResult.isSuccess()) {
          message = messageResult.value;
        }

        const authorResult = await this.gitService.getCommitAuthorDetails(
          repoPath,
          commitHash
        );
        if (authorResult.isSuccess()) {
          author = authorResult.value;
        }

        const repoNameResult = await this.gitService.getRepoNameFromRemote(
          repoPath
        );
        if (repoNameResult.isSuccess()) {
          repoName = repoNameResult.value;
        }
      }

      // Update last processed commit
      this.lastProcessedCommit = commitHash;
      await this.context.globalState.update("lastProcessedCommit", commitHash);

      // Create the commit object
      const commit: Commit = {
        hash: commitHash,
        message,
        author,
        date: commitDate,
        branch,
        repoName,
        repoPath,
      };

      // Create log message
      const logMessage = `Commit: ${commit.hash}
Message: ${commit.message}
Author: ${commit.author}
Date: ${commit.date}
Branch: ${commit.branch}
Repository: ${commit.repoName}
Repository Path: ${commit.repoPath}\n\n`;

      // Write to log file
      const trackingFilePath = path.join(this.logFilePath, this.logFile);

      // Use FileSystemService for file operations
      if (!this.fileSystemService?.validatePath(trackingFilePath)) {
        return failure(new Error("Invalid tracking file path"));
      }

      const dirResult = await this.fileSystemService.ensureDirectory(
        path.dirname(trackingFilePath)
      );
      if (dirResult.isFailure()) {
        return failure(
          new Error(
            `Failed to ensure directory exists: ${dirResult.error.message}`
          )
        );
      }

      const appendResult = await this.fileSystemService.appendToFile(
        trackingFilePath,
        logMessage
      );
      if (appendResult.isFailure()) {
        return failure(
          new Error(
            `Failed to write to log file: ${appendResult.error.message}`
          )
        );
      }

      // Show notification about tracked commit if configured
      if (
        this.notificationService &&
        this.configurationService?.showNotifications()
      ) {
        this.notificationService.showWithCallback(
          `Commit tracked: ${
            message.length > 50 ? message.substring(0, 47) + "..." : message
          }`,
          "info",
          (action) => {
            if (action === "View Log") {
              this.emit(RepositoryEvent.COMMIT_HISTORY_UPDATED);
              vscode.commands.executeCommand("commitTracker.showDetails");
            } else if (action === "Push Changes") {
              this.requestPush(this.logFilePath, trackingFilePath);
            }
          },
          {
            detail: `Repository: ${repoName}\nAuthor: ${author}\nBranch: ${branch}`,
            priority: NotificationPriority.NORMAL,
            useMarkdown: true,
          },
          "View Log",
          "Push Changes"
        );
      }

      // Emit event that commit was processed
      this.emit(RepositoryEvent.COMMIT_PROCESSED, commit, trackingFilePath);

      // Invalidate cache to ensure fresh data
      this.invalidateCache();

      // Update status
      this.notifyCommitSuccess(repoName, commitHash);

      return success(commit);
    } catch (error) {
      // Use NotificationService for error notifications
      if (this.notificationService) {
        this.notificationService.showWithCallback(
          `Failed to process commit: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
          (action) => {
            if (action === "Show Details") {
              this.logService?.showOutput(true);
            } else if (action === "Try Again") {
              this.processCommit(repo, commitHash);
            }
          },
          {
            detail: `Repository: ${repo?.rootUri?.fsPath || "unknown"}`,
            priority: NotificationPriority.HIGH,
          },
          "Show Details",
          "Try Again"
        );
      }

      this.notifyErrorStatus(
        `Failed to process commit: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Log commit details to the tracking file using pure business logic
   * @param repoPath Repository path
   * @param headCommit Commit hash
   * @param branch Branch name
   * @returns Result indicating success or failure with the tracking file path
   */
  private async logCommitDetails(
    repoPath: string,
    headCommit: string,
    branch: string
  ): Promise<Result<string, Error>> {
    try {
      this.logService?.info(
        `Logging commit details - Repo: ${repoPath}, Commit: ${headCommit}, Branch: ${branch}`
      );

      if (!this.gitService) {
        return failure(new Error("Git service not initialized"));
      }

      if (!this.fileSystemService) {
        return failure(new Error("File system service not initialized"));
      }

      // Get commit details
      const messageResult = await this.gitService.getCommitMessage(
        repoPath,
        headCommit
      );
      if (messageResult.isFailure()) {
        return failure(messageResult.error);
      }
      const message = messageResult.value;

      const commitDate = new Date().toISOString();

      const authorResult = await this.gitService.getCommitAuthorDetails(
        repoPath,
        headCommit
      );
      if (authorResult.isFailure()) {
        return failure(authorResult.error);
      }
      const author = authorResult.value;

      // Get repository name
      let repoName;
      const repoNameResult = await this.gitService.getRepoNameFromRemote(
        repoPath
      );
      if (repoNameResult.isFailure()) {
        repoName = path.basename(repoPath);
        this.logService?.warn(
          `Couldn't get repo name from remote, using directory name: ${repoName}`
        );
      } else {
        repoName = repoNameResult.value;
      }

      // Create log message
      const logMessage = `Commit: ${headCommit}
Message: ${message}
Author: ${author}
Date: ${commitDate}
Branch: ${branch}
Repository: ${repoName}
Repository Path: ${repoPath}\n\n`;

      // Write to log file
      const trackingFilePath = path.join(this.logFilePath, this.logFile);
      this.logService?.info(`Writing log to: ${trackingFilePath}`);

      // Validate path
      if (!this.fileSystemService.validatePath(trackingFilePath)) {
        return failure(new Error("Invalid tracking file path"));
      }

      // Ensure the directory exists
      const dirResult = await this.fileSystemService.ensureDirectory(
        path.dirname(trackingFilePath)
      );
      if (dirResult.isFailure()) {
        return failure(
          new Error(
            `Failed to ensure directory exists: ${dirResult.error.message}`
          )
        );
      }

      // Append to the file
      const appendResult = await this.fileSystemService.appendToFile(
        trackingFilePath,
        logMessage
      );
      if (appendResult.isFailure()) {
        return failure(
          new Error(
            `Failed to write to log file: ${appendResult.error.message}`
          )
        );
      }

      this.logService?.info(
        `Successfully logged commit details to ${this.logFile}`
      );

      // Emit event for commit processed
      const commit: Commit = {
        hash: headCommit,
        message,
        author,
        date: commitDate,
        branch,
        repoName,
        repoPath,
      };
      this.emit(RepositoryEvent.COMMIT_PROCESSED, commit);

      // Use NotificationService for notifications if configured
      if (this.configurationService?.showNotifications()) {
        if (this.notificationService) {
          this.notificationService.info(
            `Commit logged successfully. Pushing changes...`,
            { priority: NotificationPriority.NORMAL }
          );
        } else {
          // Fall back to status updates if notification service isn't available
          this.sendStatusUpdate({
            type: "normal",
            message: "Commit logged successfully",
          });
        }
      }

      // Try to push changes using safe temporary file handling
      try {
        if (this.gitService) {
          // Use the GitService's safe temporary file methods for push operation
          const scriptResult = await this.gitService.createAdvancedPushScript(
            this.logFilePath,
            trackingFilePath,
            {
              commitMessage: `Update commit log for ${repoName}:${headCommit.substring(
                0,
                7
              )}`,
              autoClose: true,
              timeout: 30, // 30 seconds timeout for push operation
            }
          );

          if (scriptResult.isFailure()) {
            this.logService?.warn(
              `Failed to create push script: ${scriptResult.error.message}`
            );
          } else {
            // Request push operation via command manager or directly
            this.requestPush(this.logFilePath, trackingFilePath);
            this.logService?.info(
              `Push operation requested with safe script: ${scriptResult.value}`
            );
          }
        }
      } catch (err) {
        // Just log the error but don't fail the commit logging operation
        this.logService?.warn(
          `Push operation setup failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      return success(trackingFilePath);
    } catch (err) {
      if (this.notificationService) {
        this.notificationService.error(`Failed to log commit details`, {
          detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
          priority: NotificationPriority.HIGH,
        });
      }

      return failure(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Process a commit directly by hash
   * @param repoPath Path to the repository
   * @param commitHash Hash of the commit to process
   * @param branch Branch name
   * @returns Result indicating success or failure
   */
  public async processCommitDirectly(
    repoPath: string,
    commitHash: string,
    branch: string
  ): Promise<Result<Commit, Error>> {
    try {
      this.logService?.info(
        `Directly processing commit ${commitHash} in ${repoPath} on branch ${branch}`
      );

      if (!commitHash) {
        return failure(new Error("No commit hash provided"));
      }

      if (!repoPath) {
        return failure(new Error("No repository path provided"));
      }

      // Skip excluded branches
      if (this.isBranchExcluded(branch)) {
        return failure(new Error(`Commit from excluded branch: ${branch}`));
      }

      // Process the commit
      const result = await this.logCommitDetails(repoPath, commitHash, branch);
      if (result.isFailure()) {
        return failure(result.error);
      }

      // Update last processed commit
      this.lastProcessedCommit = commitHash;
      await this.context.globalState.update("lastProcessedCommit", commitHash);

      // Get additional commit info
      let message = "Unknown commit message";
      let author = "Unknown author";
      let repoName = path.basename(repoPath);

      if (this.gitService) {
        const messageResult = await this.gitService.getCommitMessage(
          repoPath,
          commitHash
        );
        if (messageResult.isSuccess()) {
          message = messageResult.value;
        }

        const authorResult = await this.gitService.getCommitAuthorDetails(
          repoPath,
          commitHash
        );
        if (authorResult.isSuccess()) {
          author = authorResult.value;
        }

        const repoNameResult = await this.gitService.getRepoNameFromRemote(
          repoPath
        );
        if (repoNameResult.isSuccess()) {
          repoName = repoNameResult.value;
        }
      }

      // Create commit object
      const commit: Commit = {
        hash: commitHash,
        message,
        author,
        date: new Date().toISOString(),
        branch,
        repoName,
        repoPath,
      };

      this.emit(RepositoryEvent.COMMIT_PROCESSED, commit);
      return success(commit);
    } catch (error) {
      this.emit(RepositoryEvent.COMMIT_FAILED, repoPath, commitHash, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Process the current repository for the manual logging command
   * @param repo The repository to process
   * @returns Result indicating success or failure
   */
  public async processCurrentRepository(
    repo: any
  ): Promise<Result<Commit, Error>> {
    try {
      this.logService?.info("Manually processing repository");

      if (!repo) {
        return failure(new Error("Repository object is null or undefined"));
      }

      if (!repo.state) {
        return failure(new Error("Repository state is null or undefined"));
      }

      if (!repo.state.HEAD) {
        return failure(new Error("Repository HEAD is null or undefined"));
      }

      const headCommit = repo.state.HEAD?.commit;
      const branch = repo.state.HEAD?.name;
      const repoPath = repo.rootUri.fsPath;

      this.logService?.info(
        `Repository info - Path: ${repoPath || "unknown"}, Commit: ${
          headCommit || "unknown"
        }, Branch: ${branch || "unknown"}`
      );

      if (!headCommit) {
        return failure(new Error("No HEAD commit found"));
      }

      // Skip excluded branches
      if (this.excludedBranches.includes(branch)) {
        const error = new Error(
          `Skipping logging for excluded branch: ${branch}`
        );
        // Emit an event instead of showing UI notification
        this.emit(RepositoryEvent.COMMIT_FAILED, repo, headCommit, error);
        return failure(error);
      }

      // Process the commit
      return await this.processCommit(repo, headCommit);
    } catch (error) {
      this.handleError(
        error,
        "processing current repository",
        ErrorType.REPOSITORY,
        false
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Process repository changes using event-based notifications
   * @param repo Repository that changed
   */
  private async processRepositoryChange(repo: any): Promise<void> {
    try {
      const headCommit = repo.state.HEAD?.commit;
      const branch = repo.state.HEAD?.name;
      const repoPath = repo.rootUri.fsPath;

      this.logService?.info(
        `Repository change detected - Commit: ${headCommit}, Branch: ${branch}, Repo: ${repoPath}`
      );

      if (!headCommit) {
        this.logService?.warn("No HEAD commit found in repository");
        return;
      }

      // Skip excluded branches
      if (this.isBranchExcluded(branch)) {
        this.logService?.info(
          `Skipping logging for excluded branch: ${branch}`
        );
        return;
      }

      // Check if commit was already processed
      // First, check against the last processed commit in memory
      if (this.lastProcessedCommit === headCommit) {
        this.logService?.info(
          `Skipping already processed commit: ${headCommit}`
        );
        return;
      }

      // Then check the log file to see if this commit is already there
      try {
        if (!this.fileSystemService) {
          this.logService?.error("File system service not initialized");
          return;
        }

        const logPath = path.join(this.logFilePath, this.logFile);

        // Check if log file exists
        const existsResult = await this.fileSystemService.exists(logPath);
        if (existsResult.isFailure()) {
          this.logService?.error(
            `Error checking log file: ${existsResult.error.message}`
          );
          return;
        }

        if (existsResult.value) {
          // Read log file
          const readResult = await this.fileSystemService.readFile(logPath);
          if (readResult.isFailure()) {
            this.logService?.error(
              `Error reading log file: ${readResult.error.message}`
            );
            return;
          }

          const content = readResult.value;

          // Check if commit hash exists in the log file
          if (content.includes(`Commit: ${headCommit}`)) {
            this.logService?.info(
              `Skipping already logged commit: ${headCommit}`
            );
            return;
          }
        }
      } catch (error) {
        this.logService?.error(`Error checking commit log: ${error}`);
      }

      // Notify that a commit was detected
      this.emit(RepositoryEvent.COMMIT_DETECTED, repoPath, headCommit);
      this.notifyCommitProcessing(
        path.basename(repoPath),
        headCommit.substring(0, 7)
      );

      // Process the new commit
      this.logService?.info(`Processing new commit: ${headCommit}`);
      this.lastProcessedCommit = headCommit;

      // Save the last processed commit to the global state
      await this.context.globalState.update("lastProcessedCommit", headCommit);

      // Log the commit details
      const result = await this.logCommitDetails(repoPath, headCommit, branch);
      if (result.isFailure()) {
        this.logService?.error(
          `Failed to process commit: ${result.error.message}`
        );
        this.emit(
          RepositoryEvent.COMMIT_FAILED,
          repoPath,
          headCommit,
          result.error
        );
      } else {
        this.logService?.info(`Successfully processed commit: ${headCommit}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logService?.error(
        `Error in processRepositoryChange: ${errorMsg}`,
        error
      );
    }
  }

  /**
   * Get detailed information about all repositories being tracked
   * @returns Result containing an array of repository status objects
   */
  public getAllRepositories(): Result<RepositoryStatus[], Error> {
    try {
      const repositoryStatuses: RepositoryStatus[] = [];

      // Convert the Map values to an array
      this.repositories.forEach((status) => {
        repositoryStatuses.push(status);
      });

      return success(repositoryStatuses);
    } catch (error) {
      this.handleError(
        error,
        "getting all repositories",
        ErrorType.REPOSITORY,
        false
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get statistics about tracked commits
   * @returns Result containing repository statistics
   */
  public async getCommitStatistics(): Promise<
    Result<
      {
        totalCommits: number;
        commitsByRepo: Record<string, number>;
        commitsByAuthor: Record<string, number>;
        commitsByBranch: Record<string, number>;
        lastCommitDate: Date | null;
      },
      Error
    >
  > {
    try {
      // Check cache first
      const now = Date.now();
      if (
        this.cache.statistics &&
        now - this.cache.statistics.timestamp < this.CACHE_TTL.STATISTICS
      ) {
        return success(this.cache.statistics.data);
      }

      // Get all commits (using unlimited for statistics)
      const commitsResult = await this.getCommitHistory(1000);
      if (commitsResult.isFailure()) {
        return failure(commitsResult.error);
      }

      const commits = commitsResult.value;

      // Compute statistics
      const stats = {
        totalCommits: commits.length,
        commitsByRepo: {} as Record<string, number>,
        commitsByAuthor: {} as Record<string, number>,
        commitsByBranch: {} as Record<string, number>,
        lastCommitDate: commits.length > 0 ? new Date(commits[0].date) : null,
      };

      // Aggregate data
      for (const commit of commits) {
        // Count by repo
        if (!stats.commitsByRepo[commit.repoName]) {
          stats.commitsByRepo[commit.repoName] = 0;
        }
        stats.commitsByRepo[commit.repoName]++;

        // Count by author
        if (!stats.commitsByAuthor[commit.author]) {
          stats.commitsByAuthor[commit.author] = 0;
        }
        stats.commitsByAuthor[commit.author]++;

        // Count by branch
        if (!stats.commitsByBranch[commit.branch]) {
          stats.commitsByBranch[commit.branch] = 0;
        }
        stats.commitsByBranch[commit.branch]++;
      }

      // Store in cache
      this.cache.statistics = {
        data: stats,
        timestamp: now,
      };

      return success(stats);
    } catch (error) {
      this.handleError(error, "getting commit statistics", ErrorType.UNKNOWN);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get detailed information about unpushed commits in the tracking repository
   * @returns Result containing unpushed commit details
   */
  public async getUnpushedCommitDetails(): Promise<
    Result<
      {
        count: number;
        commitHashes: string[];
        needsPush: boolean;
      },
      Error
    >
  > {
    try {
      // Check cache first
      const now = Date.now();
      if (
        this.cache.unpushedCommits &&
        now - this.cache.unpushedCommits.timestamp <
          this.CACHE_TTL.UNPUSHED_COMMITS
      ) {
        return success(this.cache.unpushedCommits.data);
      }

      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath");

      if (!logFilePath) {
        return failure(new Error("Log file path not configured"));
      }

      // Check if this is a git repository
      if (!fs.existsSync(path.join(logFilePath, ".git"))) {
        return success({
          count: 0,
          commitHashes: [],
          needsPush: false,
        });
      }

      // Use GitService if available
      let hasUnpushedCommits = false;
      const commitHashes: string[] = [];

      if (this.gitService) {
        const unpushedResult = await this.gitService.hasUnpushedCommits(
          logFilePath
        );
        hasUnpushedCommits = unpushedResult.isSuccess()
          ? unpushedResult.value
          : false;
      } else {
        // Fallback to basic check
        try {
          const { exec } = require("child_process");
          const { promisify } = require("util");
          const execAsync = promisify(exec);

          // Get current branch
          const { stdout: branchOutput } = await execAsync(
            "git rev-parse --abbrev-ref HEAD",
            { cwd: logFilePath }
          );
          const currentBranch = branchOutput.trim();

          // Check for unpushed commits
          const { stdout: unpushedOutput } = await execAsync(
            `git cherry -v origin/${currentBranch}`,
            { cwd: logFilePath }
          );

          hasUnpushedCommits = unpushedOutput.trim().length > 0;

          // Extract commit hashes if needed
          if (hasUnpushedCommits) {
            const lines = unpushedOutput
              .split("\n")
              .filter((l: string) => l.trim());
            for (const line of lines) {
              const match = line.match(/^\+ ([a-f0-9]+)/);
              if (match) {
                commitHashes.push(match[1]);
              }
            }
          }
        } catch (error) {
          // If error occurs, assume there are unpushed commits
          hasUnpushedCommits = true;
        }
      }

      const result = {
        count: commitHashes.length || (hasUnpushedCommits ? 1 : 0),
        commitHashes,
        needsPush: hasUnpushedCommits,
      };

      // Store in cache
      this.cache.unpushedCommits = {
        data: result,
        timestamp: now,
      };

      return success(result);
    } catch (error) {
      this.handleError(
        error,
        "getting unpushed commit details",
        ErrorType.GIT_OPERATION
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get caching status for the repository manager
   * @returns Result containing cache information
   */
  public getCacheStatus(): Result<
    {
      lastProcessedCommit: string | null;
      repositoriesTracked: number;
      cacheCreated: Date;
      cacheLastUpdated: Date | null;
      cacheSizes: {
        repositoryStatus: number;
        commitHistory: boolean;
        statistics: boolean;
        unpushedCommits: boolean;
      };
    },
    Error
  > {
    try {
      const now = Date.now();
      let mostRecentUpdate: number | null = null;

      // Find most recent cache update
      this.cache.repositoryStatus.forEach((item) => {
        if (!mostRecentUpdate || item.timestamp > mostRecentUpdate) {
          mostRecentUpdate = item.timestamp;
        }
      });

      if (
        this.cache.commitHistory &&
        (!mostRecentUpdate ||
          this.cache.commitHistory.timestamp > mostRecentUpdate)
      ) {
        mostRecentUpdate = this.cache.commitHistory.timestamp;
      }

      if (
        this.cache.statistics &&
        (!mostRecentUpdate ||
          this.cache.statistics.timestamp > mostRecentUpdate)
      ) {
        mostRecentUpdate = this.cache.statistics.timestamp;
      }

      if (
        this.cache.unpushedCommits &&
        (!mostRecentUpdate ||
          this.cache.unpushedCommits.timestamp > mostRecentUpdate)
      ) {
        mostRecentUpdate = this.cache.unpushedCommits.timestamp;
      }

      return success({
        lastProcessedCommit: this.lastProcessedCommit,
        repositoriesTracked: this.cache.repositoryStatus.size,
        cacheCreated:
          this.context.globalState.get("cacheCreated") || new Date(),
        cacheLastUpdated: mostRecentUpdate ? new Date(mostRecentUpdate) : null,
        cacheSizes: {
          repositoryStatus: this.cache.repositoryStatus.size,
          commitHistory: !!this.cache.commitHistory,
          statistics: !!this.cache.statistics,
          unpushedCommits: !!this.cache.unpushedCommits,
        },
      });
    } catch (error) {
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Check branch exclusion status for a given branch
   * @param branchName The name of the branch to check
   * @returns True if the branch is excluded, false otherwise
   */
  public isBranchExcluded(branchName: string): boolean {
    return this.excludedBranches.includes(branchName);
  }

  /**
   * Get the history of processed commits from the tracking log
   * @param limit Optional number of commits to retrieve (default: 10)
   * @returns Result containing commit history
   */
  public async getCommitHistory(
    limit: number = 10
  ): Promise<Result<Commit[], Error>> {
    // Use cache if available and not expired
    if (
      this.cache.commitHistory &&
      Date.now() < this.cache.commitHistory.timestamp
    ) {
      const cachedCommits = this.cache.commitHistory.data.slice(0, limit);
      return success(cachedCommits);
    }

    try {
      if (!this.fileSystemService) {
        return failure(new Error("File system service not initialized"));
      }

      const trackingFilePath = path.join(this.logFilePath, this.logFile);

      // Check if file exists before trying to read it
      const existsResult = await this.fileSystemService.exists(
        trackingFilePath
      );
      if (existsResult.isFailure()) {
        return failure(existsResult.error);
      }

      if (!existsResult.value) {
        return success([]);
      }

      // Read the file
      const readResult = await this.fileSystemService.readFile(
        trackingFilePath
      );
      if (readResult.isFailure()) {
        return failure(readResult.error);
      }

      const content = readResult.value;
      const commits: Commit[] = [];

      // Parse the log file content to extract commits
      const commitBlocks = content
        .split("\n\n")
        .filter((block) => block.trim().length > 0);

      for (const block of commitBlocks) {
        const lines = block.split("\n");
        const commit: Partial<Commit> = {};

        for (const line of lines) {
          const [key, ...valueParts] = line.split(": ");
          const value = valueParts.join(": "); // Rejoin in case message contains colons

          if (key === "Commit") {
            commit.hash = value;
          } else if (key === "Message") {
            commit.message = value;
          } else if (key === "Author") {
            commit.author = value;
          } else if (key === "Date") {
            commit.date = value;
          } else if (key === "Branch") {
            commit.branch = value;
          } else if (key === "Repository") {
            commit.repoName = value;
          } else if (key === "Repository Path") {
            commit.repoPath = value;
          }
        }

        if (
          commit.hash &&
          commit.message &&
          commit.author &&
          commit.date &&
          commit.branch &&
          commit.repoName &&
          commit.repoPath
        ) {
          commits.push(commit as Commit);
        }
      }

      // Sort commits by date (newest first)
      commits.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateB.getTime() - dateA.getTime();
      });

      // Cache the results
      this.cache.commitHistory = {
        data: commits,
        timestamp: Date.now() + this.CACHE_TTL.COMMIT_HISTORY,
      };

      return success(commits.slice(0, limit));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logService?.error(
        `Failed to get commit history: ${errorMsg}`,
        error
      );
      return failure(new Error(`Failed to get commit history: ${errorMsg}`));
    }
  }

  // Replace the existing getRepositoryStatus with this cached version
  public async getRepositoryStatus(
    repo: any
  ): Promise<Result<RepositoryStatus, Error>> {
    try {
      const repoPath = repo.rootUri?.fsPath;
      if (!repoPath) {
        return failure(new Error("Repository has no path"));
      }

      // Check cache first
      const cachedStatus = this.cache.repositoryStatus.get(repoPath);
      const now = Date.now();

      if (
        cachedStatus &&
        now - cachedStatus.timestamp < this.CACHE_TTL.REPO_STATUS
      ) {
        return success(cachedStatus.data);
      }

      // If not in cache or expired, get fresh status
      const headCommit = repo.state.HEAD?.commit;
      const branchName = repo.state.HEAD?.name;
      const hasChanges = repo.state.workingTreeChanges.length > 0;

      // Get repository name (this could be expensive, but at least it's cached)
      let repoName = path.basename(repoPath);
      if (this.gitService) {
        try {
          const remoteName = await this.gitService.getRepoNameFromRemote(
            repoPath
          );

          if (remoteName.isSuccess()) {
            repoName = remoteName.value || repoName;
          }
        } catch (error) {
          // If there's an error getting the remote name, keep using the directory name
        }
      }

      const status: RepositoryStatus = {
        repoPath,
        currentCommit: headCommit,
        branchName,
        hasChanges,
        repoName,
      };

      // Store in cache
      this.cache.repositoryStatus.set(repoPath, {
        data: status,
        timestamp: now,
      });

      return success(status);
    } catch (error) {
      this.handleError(
        error,
        "getting repository status",
        ErrorType.REPOSITORY
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Add a listener for repository changes
   * @param repo The repository to listen to
   * @param callback Function to call when repository changes
   * @returns Result indicating success or registration
   */
  public addRepositoryListener(
    repo: any,
    callback: (status: RepositoryStatus) => void
  ): Result<vscode.Disposable, Error> {
    try {
      if (!repo || !repo.rootUri) {
        return failure(new Error("Invalid repository"));
      }

      const repoPath = repo.rootUri.fsPath;

      // Create a listener for the specific repository
      const listener = this.on(
        RepositoryEvent.REPOSITORY_CHANGED,
        (status: RepositoryStatus) => {
          if (status.repoPath === repoPath) {
            callback(status);
          }
        }
      );

      const disposable = {
        dispose: () => {
          this.removeListener(RepositoryEvent.REPOSITORY_CHANGED, callback);
        },
      };

      this.disposableManager.register(disposable);
      return success(disposable);
    } catch (error) {
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Private implementation methods

  /**
   * Update status information for a repository
   * @param repo The repository to update status for
   * @returns Result indicating success or failure with updated status
   */
  private async updateRepositoryStatus(
    repo: any
  ): Promise<Result<RepositoryStatus, Error>> {
    try {
      if (!repo || !repo.rootUri) {
        return failure(new Error("Invalid repository object"));
      }

      const repoPath = repo.rootUri.fsPath;
      const currentCommit = repo.state.HEAD?.commit;
      const branchName = repo.state.HEAD?.name;
      const hasChanges =
        repo.state.workingTreeChanges.length > 0 ||
        repo.state.indexChanges.length > 0;

      // Get repository name
      let repoName = path.basename(repoPath);
      try {
        if (this.gitService) {
          const remoteNameResult = await this.gitService.getRepoNameFromRemote(
            repoPath
          );
          if (remoteNameResult.isSuccess()) {
            repoName = remoteNameResult.value || repoName;
          }
        }
      } catch (error) {
        // Keep using the directory name if there's an error
      }

      const status: RepositoryStatus = {
        repoPath,
        currentCommit,
        branchName,
        hasChanges,
        repoName,
      };

      // Get the previous status to check for changes
      const previousStatus = this.repositories.get(repoPath);

      // Store the status
      this.repositories.set(repoPath, status);

      // Emit status changed event with previous and new status
      this.emit(
        RepositoryEvent.REPOSITORY_STATUS_CHANGED,
        previousStatus,
        status
      );

      // Emit repository changed event
      this.emit(RepositoryEvent.REPOSITORY_CHANGED, status);

      if (
        previousStatus?.currentCommit !== currentCommit &&
        currentCommit &&
        !this.excludedBranches.includes(branchName || "")
      ) {
        this.emit(RepositoryEvent.COMMIT_DETECTED, repo, currentCommit);
        const result = await this.processCommit(repo, currentCommit);

        if (result.isSuccess()) {
          // Emit success with commit details
          this.emit(
            RepositoryEvent.COMMIT_PROCESSED,
            result.value,
            path.join(this.logFilePath, this.logFile)
          );
        } else {
          // Only emit real errors, not skipped commits
          const error = result.error;
          if (
            !error.message.includes("Skipping") &&
            !error.message.includes("already processed") &&
            !error.message.includes("already in log file")
          ) {
            this.emit(
              RepositoryEvent.COMMIT_FAILED,
              repo,
              currentCommit,
              error
            );
          }
        }
      }

      return success(status);
    } catch (error) {
      this.logService?.error(`Error updating repository status: ${error}`);
      this.emit(RepositoryEvent.ERROR, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Set up listeners for repository changes
   * @param api The Git extension API
   * @returns Result indicating success or failure
   */
  private setupRepositoryListeners(api: any): Result<boolean, Error> {
    try {
      // Clean up any existing listeners
      this.repoListeners.forEach((listener) => {
        listener.dispose();
      });
      this.repoListeners.clear();

      const activeRepos = api.repositories.filter(
        (repo: any) => repo.state.HEAD
      );
      this.logService?.info(`Found ${activeRepos.length} active repositories`);

      let setupCount = 0;
      let errorCount = 0;

      activeRepos.forEach((repo: any) => {
        const repoPath = repo.rootUri?.fsPath || "unknown";
        this.logService?.info(
          `Setting up listener for repository: ${repoPath}`
        );

        // Add a direct check of the repository state
        if (!repo.state.onDidChange) {
          this.logService?.error(
            `Repository state.onDidChange is not available for ${repoPath}`
          );
          errorCount++;
          return;
        }

        const debouncedOnDidChange = debounce(async () => {
          this.logService?.info(`Repository change detected in ${repoPath}`);
          const result = await this.updateRepositoryStatus(repo);
          if (result.isFailure()) {
            this.logService?.error(
              `Failed to update repository status: ${result.error.message}`
            );
          }
        }, 300);

        try {
          const listener = repo.state.onDidChange(debouncedOnDidChange);
          const disposable = { dispose: () => listener.dispose() };
          this.repoListeners.set(repoPath, disposable);
          this.disposableManager.register(disposable);
          this.logService?.info(
            `Successfully registered change listener for ${repoPath}`
          );
          setupCount++;
        } catch (error) {
          this.logService?.error(
            `Failed to register change listener for ${repoPath}: ${error}`
          );
          errorCount++;
        }
      });

      // Register for repository changes (new repositories added)
      try {
        this.logService?.info("Setting up listener for new repositories");
        const repoChangeListener = api.onDidOpenRepository((repo: any) => {
          this.logService?.info(
            `New repository opened: ${repo.rootUri?.fsPath || "unknown"}`
          );
          const result = this.setupRepositoryListener(repo);
          if (result.isFailure()) {
            this.logService?.error(
              `Failed to setup repository listener: ${result.error.message}`
            );
          }
        });

        const disposable = { dispose: () => repoChangeListener.dispose() };
        this.disposableManager.register(disposable);
        this.repoListeners.set("global", disposable);
        this.logService?.info(
          "Successfully registered listener for new repositories"
        );
      } catch (error) {
        this.logService?.error(
          `Failed to register listener for new repositories: ${error}`
        );
        errorCount++;
      }

      if (errorCount > 0) {
        return success(false); // Some repositories failed to setup but overall operation succeeded
      }
      return success(true);
    } catch (error) {
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Set up a listener for a single repository
   * @param repo The repository to listen to
   * @returns Result indicating success or failure
   */
  private setupRepositoryListener(repo: any): Result<boolean, Error> {
    try {
      const repoPath = repo.rootUri?.fsPath || "unknown";

      if (this.repoListeners.has(repoPath)) {
        // Already have a listener for this repo
        return success(false);
      }

      const debouncedOnDidChange = debounce(async () => {
        const result = await this.updateRepositoryStatus(repo);
        if (result.isFailure()) {
          this.logService?.error(
            `Failed to update repository status: ${result.error.message}`
          );
        }
      }, 300);

      try {
        const listener = repo.state.onDidChange(debouncedOnDidChange);
        const disposable = { dispose: () => listener.dispose() };
        this.repoListeners.set(repoPath, disposable);
        this.disposableManager.register(disposable);
        this.logService?.info(`Added listener for repository: ${repoPath}`);
        return success(true);
      } catch (error) {
        return failure(
          new Error(
            `Failed to add listener for repository ${repoPath}: ${error}`
          )
        );
      }
    } catch (error) {
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Set up direct monitoring for commits
   * @param api The Git extension API
   * @returns Result indicating success or failure
   */
  private setupDirectCommitMonitoring(api: any): Result<boolean, Error> {
    try {
      this.logService?.info("Setting up direct commit monitoring");

      // Function to process repositories periodically
      const processRepositories = () => {
        const repos = api.repositories;
        repos.forEach((repo: any) => {
          this.updateRepositoryStatus(repo).catch((error) => {
            this.logService?.error(`Error monitoring repository: ${error}`);
          });
        });
      };

      // Set up an interval to periodically check repositories
      const intervalId = setInterval(processRepositories, 5000);

      // Register the interval for cleanup
      this.disposableManager.register({
        dispose: () => clearInterval(intervalId),
      });

      this.logService?.info("Direct commit monitoring set up successfully");
      return success(true);
    } catch (error) {
      this.logService?.error(
        `Failed to set up direct commit monitoring: ${error}`
      );
      this.emit(RepositoryEvent.ERROR, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private setupConfigChangeListener(): void {
    // If ConfigurationService is available, use its event
    if (this.configurationService) {
      const disposable = this.configurationService.onDidChangeConfiguration(
        (change) => {
          if (
            change.key === "logFilePath" ||
            change.key === "logFile" ||
            change.key === "excludedBranches"
          ) {
            this.loadConfiguration();
          }
        }
      );

      this.disposableManager.register(disposable);
      return;
    }

    // Legacy approach if ConfigurationService isn't provided
    const configListener = vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration("commitTracker")) {
          this.loadConfiguration();
        }
      }
    );

    this.disposableManager.register({
      dispose: () => configListener.dispose(),
    });
  }

  /**
   * Load configuration from workspace settings
   * Emits configuration update event instead of direct UI updates
   */
  private loadConfiguration(): void {
    if (!this.configurationService) {
      // Fall back to direct loading if configurationService is not available
      const config = vscode.workspace.getConfiguration("commitTracker");
      this.logFilePath = config.get<string>("logFilePath", "");
      this.logFile = config.get<string>("logFile", "commit-tracker.log");
      this.excludedBranches = config.get<string[]>("excludedBranches", []);
    } else {
      // Use configurationService
      this.logFilePath = this.configurationService.getTrackerRepoPath() || "";
      this.logFile =
        this.configurationService.getTrackerLogFile() || "commit-tracker.log";
      this.excludedBranches = this.configurationService.getExcludedBranches();
    }

    // Emit configuration update event
    this.emit(RepositoryEvent.CONFIG_UPDATED, {
      logFilePath: this.logFilePath,
      logFile: this.logFile,
      excludedBranches: this.excludedBranches,
    });

    if (this.logService) {
      this.logService.info(
        `Configuration loaded - Log path: ${this.logFilePath}, Log file: ${this.logFile}`
      );
      this.logService.debug(
        `Excluded branches: ${JSON.stringify(this.excludedBranches)}`
      );
    }
  }

  /**
   * Update the configuration settings
   */
  public updateConfiguration(
    logFilePath: string,
    logFile: string,
    excludedBranches: string[]
  ): void {
    this.logFilePath = logFilePath;
    this.logFile = logFile;
    this.excludedBranches = excludedBranches;
  }

  /**
   * Load configuration from ConfigurationService
   */
  private loadConfigurationFromService(): void {
    if (!this.configurationService) {
      return;
    }

    this.logService?.info("Loading configuration from service");

    this.logFilePath = this.configurationService.get<string>("logFilePath", "");
    this.logFile = this.configurationService.get<string>("logFile", "");
    this.excludedBranches = this.configurationService.get<string[]>(
      "excludedBranches",
      []
    );

    // Register for future configuration changes
    if (!this._configChangeDisposable) {
      this._configChangeDisposable =
        this.configurationService.onDidChangeConfiguration((event) => {
          if (
            ["logFilePath", "logFile", "excludedBranches"].includes(event.key)
          ) {
            this.logService?.info(`Configuration changed: ${event.key}`);
            this.loadConfigurationFromService();
            this.emit(RepositoryEvent.CONFIG_UPDATED, {
              logFilePath: this.logFilePath,
              logFile: this.logFile,
              excludedBranches: this.excludedBranches,
            });
          }
        });

      this.disposableManager.register(this._configChangeDisposable);
    }
  }

  /**
   * Check for unpushed commits in the tracking repository
   * @returns Result indicating if there are unpushed commits
   */
  public async checkUnpushedCommits(): Promise<Result<boolean, Error>> {
    try {
      if (!this.gitService) {
        return failure(new Error("Git service not initialized"));
      }

      if (!this.fileSystemService) {
        return failure(new Error("File system service not initialized"));
      }

      // Make sure tracking directory exists before checking
      const dirExistsResult = await this.fileSystemService.exists(
        this.logFilePath
      );
      if (dirExistsResult.isFailure()) {
        return failure(dirExistsResult.error);
      }

      if (!dirExistsResult.value) {
        return failure(
          new Error(`Tracking directory does not exist: ${this.logFilePath}`)
        );
      }

      // Check if this is actually a git repository
      const gitDirResult = await this.fileSystemService.exists(
        path.join(this.logFilePath, ".git")
      );
      if (gitDirResult.isFailure()) {
        return failure(gitDirResult.error);
      }

      if (!gitDirResult.value) {
        return failure(new Error(`Not a git repository: ${this.logFilePath}`));
      }

      // Use gitService to check for unpushed commits
      const unpushedCommits = await this.gitService.hasUnpushedCommits(
        this.logFilePath
      );

      // Notify through events if there are unpushed commits
      if (unpushedCommits.isSuccess() && unpushedCommits.value) {
        // Update status bar
        this.statusManager?.updateUnpushedIndicator(true);

        // Show notification if we have unpushed commits
        if (this.notificationService && unpushedCommits.value) {
          this.notificationService
            .warn(
              "There are unpushed commits in the tracking repository.",
              { priority: NotificationPriority.NORMAL },
              "Push Changes"
            )
            .then((selection) => {
              if (selection === "Push Changes") {
                this.requestPush(
                  this.logFilePath,
                  path.join(this.logFilePath, this.logFile)
                );
              }
            });
        }

        return success(true);
      } else {
        this.statusManager?.updateUnpushedIndicator(false);
        return success(false);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logService?.error(
        `Failed to check unpushed commits: ${errorMsg}`,
        error
      );
      return failure(
        new Error(`Failed to check unpushed commits: ${errorMsg}`)
      );
    }
  }

  /**
   * Connect to GitService for repo operations
   * @param gitService Service to perform git operations
   */
  public connectGitService(gitService: GitService): void {
    this.gitService = gitService;
    // Invalidate cache when connecting a new service
    this.invalidateCache();
  }

  /**
   * Send a status update event that StatusManager can listen to
   * @param update Status update information
   */
  public sendStatusUpdate(update: StatusUpdate): void {
    this.emit("status-update", update);
  }

  /**
   * Notify about normal tracking status
   */
  public notifyNormalStatus(): void {
    this.emit(RepositoryEvent.STATUS_UPDATE, {
      type: "normal",
      message: "Tracking active",
    });
  }

  /**
   * Notify about a repository error
   * @param error The error that occurred
   * @param details Additional error details
   */
  public notifyErrorStatus(error: Error | string, details?: string): void {
    const errorMessage = error instanceof Error ? error.message : error;
    this.emit(RepositoryEvent.STATUS_UPDATE, {
      type: "error",
      message: errorMessage,
      details,
    });
  }

  /**
   * Notify about commit processing
   * @param repoName Repository name
   * @param commitHash Commit hash being processed
   */
  public notifyCommitProcessing(repoName: string, commitHash: string): void {
    this.emit(RepositoryEvent.STATUS_UPDATE, {
      type: "processing",
      message: `Processing commit in ${repoName}`,
      data: {
        repoName,
        commitHash: commitHash.substring(0, 7),
      },
    });
  }

  /**
   * Notify about successful commit processing
   * @param repoName Repository name
   * @param commitHash Processed commit hash
   */
  public notifyCommitSuccess(repoName: string, commitHash: string): void {
    this.emit(RepositoryEvent.STATUS_UPDATE, {
      type: "info",
      message: `Commit ${commitHash.substring(0, 7)} logged`,
      duration: 3000,
      data: {
        repoName,
        commitHash: commitHash.substring(0, 7),
      },
    });
  }

  /**
   * Report current repository state
   * @returns A summary of tracked repositories and their status
   */
  public getRepositorySummary(): Result<
    {
      totalRepositories: number;
      trackedRepositories: number;
      repositoriesWithChanges: number;
      activeRepository?: string;
    },
    Error
  > {
    try {
      const repoStatuses = Array.from(this.repositories.values());
      const totalRepos = repoStatuses.length;
      const trackedRepos = repoStatuses.filter(
        (r) => !this.isBranchExcluded(r.branchName || "")
      ).length;
      const reposWithChanges = repoStatuses.filter((r) => r.hasChanges).length;

      // Find active repository (could be focused in VS Code)
      let activeRepo: string | undefined = undefined;
      if (vscode.window.activeTextEditor) {
        const activeDoc = vscode.window.activeTextEditor.document;
        if (activeDoc && activeDoc.uri.scheme === "file") {
          const activeFilePath = activeDoc.uri.fsPath;
          // Find which repo this file belongs to
          for (const repo of this.repositories.values()) {
            if (activeFilePath.startsWith(repo.repoPath)) {
              activeRepo = repo.repoName;
              break;
            }
          }
        }
      }

      return success({
        totalRepositories: totalRepos,
        trackedRepositories: trackedRepos,
        repositoriesWithChanges: reposWithChanges,
        activeRepository: activeRepo,
      });
    } catch (error) {
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Request a Git operation in a VS Code terminal
   * This delegates terminal creation to the CommandManager
   * @param workingDirectory The directory to execute commands in
   * @param command Git command to execute
   * @param terminalName Optional terminal name
   */
  public requestTerminalOperation(
    workingDirectory: string,
    command: string,
    terminalName: string = "Commit Tracker"
  ): void {
    this.emit(
      RepositoryEvent.TERMINAL_OPERATION_REQUESTED,
      workingDirectory,
      command,
      terminalName
    );
  }

  /**
   * Request setup when configuration is missing or invalid
   */
  public requestSetup(): void {
    // First emit the legacy event for backward compatibility
    this.emit(RepositoryEvent.SETUP_REQUESTED);

    // Use NotificationService if available
    if (this.notificationService) {
      this.notificationService.showWithCallback(
        "Setup required for Commit Tracker",
        "info",
        (action) => {
          if (action === "Setup Now") {
            vscode.commands.executeCommand("commitTracker.setupTracker");
          } else if (action === "Open Documentation") {
            vscode.env.openExternal(
              vscode.Uri.parse(
                "https://github.com/your-username/commit-tracker-vs-code-extension/blob/main/README.md"
              )
            );
          }
        },
        {
          detail:
            "The extension needs to be configured before it can track commits.",
        },
        "Setup Now",
        "Open Documentation"
      );
    } else {
      // Legacy status update if notification service isn't available
      this.sendStatusUpdate({
        type: "warning",
        message: "Setup required for Commit Tracker",
      });

      // Show built-in info message as fallback
      vscode.window
        .showInformationMessage(
          "Setup required for Commit Tracker",
          "Setup Now"
        )
        .then((selection) => {
          if (selection === "Setup Now") {
            vscode.commands.executeCommand("commitTracker.setupTracker");
          }
        });
    }
  }

  /**
   * Request display of repository information
   */
  public requestRepositoryInfo(): void {
    // First emit the legacy event for backward compatibility
    this.emit(RepositoryEvent.REPOSITORY_INFO_REQUESTED);

    // Use the repository summary to get actual data
    const summaryResult = this.getRepositorySummary();

    // Use NotificationService if available
    if (this.notificationService && summaryResult.isSuccess()) {
      const summary = summaryResult.value;

      // Build a detailed message about repositories
      const detail = [
        `Total Repositories: ${summary.totalRepositories}`,
        `Tracked Repositories: ${summary.trackedRepositories}`,
        `Repositories With Changes: ${summary.repositoriesWithChanges}`,
      ];

      if (summary.activeRepository) {
        detail.push(`Active Repository: ${summary.activeRepository}`);
      }

      // Use showWithCallback instead of direct info call with actions
      this.notificationService.showWithCallback(
        "Repository Information",
        "info",
        (action) => {
          if (action === "Show Details") {
            vscode.commands.executeCommand(
              "commitTracker.showRepositoryStatus"
            );
          } else if (action === "Log Current Commit") {
            vscode.commands.executeCommand("commitTracker.logCurrentCommit");
          }
        },
        {
          detail: detail.join("\n"),
        },
        "Show Details",
        "Log Current Commit"
      );
    } else {
      // Legacy approach if notification service isn't available
      vscode.commands.executeCommand("commitTracker.showRepositoryStatus");
    }
  }

  /**
   * Request a push operation via CommandManager
   * @param logFilePath Path to the log directory
   * @param trackingFilePath Path to the tracking file
   */
  public requestPush(logFilePath: string, trackingFilePath: string): void {
    this.emit(RepositoryEvent.PUSH_REQUESTED, logFilePath, trackingFilePath);
  }

  /**
   * Set up file watchers to monitor the commit log file
   * @returns Result indicating success or failure
   */
  public async setupLogFileWatcher(): Promise<Result<FileWatcher, Error>> {
    if (!this.fileSystemService) {
      return failure(
        new Error("FileSystemService not available for file watching")
      );
    }

    // Get the path to the log file
    const logFilePath = path.join(this.logFilePath, this.logFile);
    this.logService?.info(`Setting up watcher for log file: ${logFilePath}`);

    try {
      // Check if the file exists first
      const fileExistsResult = await this.fileSystemService.exists(logFilePath);
      if (fileExistsResult.isFailure()) {
        return failure(fileExistsResult.error);
      }

      // If the log file doesn't exist yet, watch the directory instead
      if (!fileExistsResult.value) {
        this.logService?.info(
          `Log file doesn't exist yet, watching directory: ${this.logFilePath}`
        );
        return this.setupLogDirectoryWatcher();
      }

      // Watch the log file for changes
      const result = this.fileSystemService.watchFile(logFilePath, (event) => {
        if (event === "change") {
          this.logService?.debug(`Log file changed: ${logFilePath}`);
          this.emit(RepositoryEvent.COMMIT_HISTORY_UPDATED);

          // Check for unpushed commits when the log changes
          this.checkUnpushedCommits()
            .then((result) => {
              if (result.isSuccess()) {
                const hasUnpushed = result.value;
                this.emit(
                  RepositoryEvent.UNPUSHED_COMMITS_CHANGED,
                  hasUnpushed
                );
              }
            })
            .catch((error) => {
              this.handleError(
                error,
                "checkUnpushedCommits",
                ErrorType.GIT_OPERATION
              );
            });
        } else if (event === "delete") {
          this.logService?.warn(`Log file was deleted: ${logFilePath}`);
          // If the file was deleted, set up a directory watcher
          this.setupLogDirectoryWatcher();
        }
      });

      if (result.isSuccess()) {
        this.logService?.info(
          `Successfully set up watcher for log file: ${logFilePath}`
        );
        return result;
      } else {
        this.logService?.error(
          `Failed to set up log file watcher: ${result.error.message}`
        );
        return failure(result.error);
      }
    } catch (error) {
      this.logService?.error(`Error setting up log file watcher: ${error}`);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Watch the log directory for file creation or changes
   * @returns Result indicating success or failure
   */
  private setupLogDirectoryWatcher(): Result<FileWatcher, Error> {
    if (!this.fileSystemService) {
      return failure(
        new Error("FileSystemService not available for directory watching")
      );
    }

    this.logService?.info(
      `Setting up watcher for log directory: ${this.logFilePath}`
    );

    const result = this.fileSystemService.watchDirectory(
      this.logFilePath,
      (event, filePath) => {
        // Only care about the specific log file
        if (path.basename(filePath) === this.logFile) {
          if (event === "create" || event === "change") {
            this.logService?.debug(`Log file ${event}: ${filePath}`);
            this.emit(RepositoryEvent.COMMIT_HISTORY_UPDATED);

            // Update unpushed commits status
            this.checkUnpushedCommits()
              .then((result) => {
                if (result.isSuccess()) {
                  this.emit(
                    RepositoryEvent.UNPUSHED_COMMITS_CHANGED,
                    result.value
                  );
                }
              })
              .catch((error) => {
                this.handleError(
                  error,
                  "checkUnpushedCommits",
                  ErrorType.GIT_OPERATION
                );
              });
          }
        }
      },
      { extensions: [path.extname(this.logFile)] }
    );

    if (result.isFailure()) {
      this.logService?.error(
        `Failed to set up log directory watcher: ${result.error.message}`
      );
    } else {
      this.logService?.info(
        `Successfully set up watcher for log directory: ${this.logFilePath}`
      );
    }

    return result;
  }

  /**
   * Watch repositories for changes in their .git directories
   * This is useful for tracking actions like new commits, checkout, etc.
   */
  public setupRepositoryGitWatchers(): void {
    if (!this.fileSystemService) {
      this.logService?.error(
        "FileSystemService not available for Git directory watching"
      );
      return;
    }

    // For each repository we're tracking
    for (const [repoPath, status] of this.repositories.entries()) {
      const gitDir = path.join(repoPath, ".git");

      // Check if the .git directory exists
      this.fileSystemService.exists(gitDir).then((result) => {
        if (result.isSuccess() && result.value) {
          // Watch these specific files/dirs in the .git directory
          const pathsToWatch = [
            path.join(gitDir, "HEAD"), // Current branch/commit
            path.join(gitDir, "refs"), // Branch and tag references
            path.join(gitDir, "COMMIT_EDITMSG"), // Last commit message
          ];

          // Set up the watchers
          this.fileSystemService!.watchPaths(
            pathsToWatch.filter((p) => fs.existsSync(p)), // Only watch paths that exist
            (event, filePath) => {
              this.logService?.debug(
                `Git change detected in ${repoPath}: ${filePath} (${event})`
              );

              // Wait briefly to let Git finish its operations
              setTimeout(() => {
                // Update repository status
                this.updateRepositoryStatus({
                  rootUri: { fsPath: repoPath },
                }).then((statusResult) => {
                  if (statusResult.isSuccess()) {
                    this.emit(
                      RepositoryEvent.REPOSITORY_CHANGED,
                      statusResult.value
                    );
                  }
                });
              }, 500);
            },
            { recursive: true }
          );
        }
      });
    }
  }

  /**
   * Dispose of all resources
   */
  public dispose(): void {
    this.emit(RepositoryEvent.TRACKING_STOPPED);

    this.repoListeners.forEach((listener) => {
      listener.dispose();
    });
    this.repoListeners.clear();
    this.removeAllListeners();
  }
}
