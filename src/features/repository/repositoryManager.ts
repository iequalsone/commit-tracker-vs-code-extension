import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  getCommitAuthorDetails,
  getCommitMessage,
  getRepoNameFromRemote,
  pullChanges,
} from "../../services/gitService";
import {
  ensureDirectoryExists,
  appendToFile,
  validatePath,
} from "../../services/fileService";
import { logInfo, logError } from "../../utils/logger";
import { debounce } from "../../utils/debounce";
import { DisposableManager } from "../../utils/DisposableManager";
import { Result, success, failure } from "../../utils/result";
import { EventEmitter } from "events";
import { CommandManager } from "../commands/commandManager";

import { StatusManager } from "../status/statusManager";
import {
  ErrorHandlingService,
  ErrorType,
} from "../../services/errorHandlingService";

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
}

export class RepositoryManager extends EventEmitter {
  private disposableManager: DisposableManager;
  private logFilePath: string;
  private logFile: string;
  private excludedBranches: string[];
  private context: vscode.ExtensionContext;
  private lastProcessedCommit: string | null;
  private repoListeners: Map<string, vscode.Disposable> = new Map();
  private repositories: Map<string, RepositoryStatus> = new Map();
  private statusManager: StatusManager | undefined;
  private commandManager: CommandManager | undefined;
  private errorHandlingService: ErrorHandlingService;

  constructor(
    context: vscode.ExtensionContext,
    statusManager?: StatusManager,
    commandManager?: CommandManager,
    errorHandlingService?: ErrorHandlingService
  ) {
    super();
    this.context = context;
    this.statusManager = statusManager;
    this.commandManager = commandManager;
    this.disposableManager = DisposableManager.getInstance();
    this.lastProcessedCommit = context.globalState.get(
      "lastProcessedCommit",
      null
    );

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
    const config = vscode.workspace.getConfiguration("commitTracker");
    this.logFilePath = config.get<string>("logFilePath")!;
    this.logFile = config.get<string>("logFile")!;
    this.excludedBranches = config.get<string[]>("excludedBranches")!;

    this.setupConfigChangeListener();

    // Set up event listeners to update status
    if (this.statusManager) {
      this.setupStatusManagerEvents();
    }
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

    // Use the error handling service
    this.errorHandlingService.handleError(
      error,
      operation,
      errorType,
      showNotification,
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
    if (!this.statusManager) return;

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
      logInfo("Initializing repository manager");

      // Emit event before initialization starts
      this.emit(RepositoryEvent.TRACKING_STARTED);

      try {
        await pullChanges(this.logFilePath);
        logInfo("Successfully pulled latest changes from tracking repository");
      } catch (err) {
        this.handleError(
          err,
          "pulling changes from tracking repository",
          ErrorType.GIT_OPERATION,
          false
        );
      }

      const gitExtension =
        vscode.extensions.getExtension("vscode.git")?.exports;
      if (!gitExtension) {
        const error = new Error("Git extension is not available");
        this.handleError(
          error,
          "initializing repository monitoring",
          ErrorType.CONFIGURATION,
          true
        );
        return failure(error);
      }

      const api = gitExtension.getAPI(1);
      if (!api) {
        return failure(new Error("Failed to get Git API"));
      }

      logInfo("Git API available, setting up repository listeners");

      // Set up monitoring methods
      const listenersResult = this.setupRepositoryListeners(api);
      if (listenersResult.isFailure()) {
        return failure(listenersResult.error);
      }

      const monitoringResult = this.setupDirectCommitMonitoring(api);
      if (monitoringResult.isFailure()) {
        return failure(monitoringResult.error);
      }

      // Process current commits immediately
      logInfo("Processing current repository states");
      try {
        const repos = api.repositories;
        for (const repo of repos) {
          if (repo.state.HEAD?.commit) {
            const result = await this.updateRepositoryStatus(repo);
            if (result.isFailure()) {
              logError(
                `Error updating repository status: ${result.error.message}`
              );
            }
          }
        }
      } catch (error) {
        logError(`Error processing current repositories: ${error}`);
      }

      // Emit event after successful initialization
      this.emit(RepositoryEvent.TRACKING_STARTED, api.repositories.length);
      return success(true);
    } catch (error) {
      this.handleError(
        error,
        "initializing repository manager",
        ErrorType.UNKNOWN,
        true
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
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
   * @param repo The repository containing the commit
   * @param commitHash The commit hash to process
   * @returns Result indicating success or failure
   */
  public async processCommit(
    repo: any,
    commitHash: string
  ): Promise<Result<Commit, Error>> {
    try {
      if (!repo || !commitHash) {
        return failure(new Error("Invalid repository or commit hash"));
      }

      const repoPath = repo.rootUri?.fsPath;
      const branch = repo.state?.HEAD?.name || "unknown";

      // Show processing status
      if (this.statusManager) {
        const repoName = path.basename(repoPath);
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

      // Check if it's in the log file
      try {
        const logPath = path.join(this.logFilePath, this.logFile);
        if (fs.existsSync(logPath)) {
          const logContent = fs.readFileSync(logPath, "utf8");
          if (logContent.includes(commitHash)) {
            return failure(
              new Error(`Commit already in log file: ${commitHash}`)
            );
          }
        }
      } catch (error) {
        logError(`Error checking log file: ${error}`);
      }

      // Get commit details
      const message = await getCommitMessage(repoPath, commitHash);
      const author = await getCommitAuthorDetails(repoPath, commitHash);
      const date = new Date().toISOString();

      let repoName;
      try {
        repoName = await getRepoNameFromRemote(repoPath);
      } catch (error) {
        repoName = path.basename(repoPath);
      }

      const commit: Commit = {
        hash: commitHash,
        message,
        author,
        date,
        branch,
        repoName,
        repoPath,
      };

      // Update last processed commit
      this.lastProcessedCommit = commitHash;
      await this.context.globalState.update("lastProcessedCommit", commitHash);

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

      if (!validatePath(trackingFilePath)) {
        return failure(new Error("Invalid tracking file path"));
      }

      ensureDirectoryExists(path.dirname(trackingFilePath));
      await appendToFile(trackingFilePath, logMessage);

      // Emit event that commit was processed
      this.emit(RepositoryEvent.COMMIT_PROCESSED, commit, trackingFilePath);

      return success(commit);
    } catch (error) {
      this.handleError(
        error,
        `processing commit ${commitHash}`,
        ErrorType.GIT_OPERATION,
        false
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Log commit details to the tracking file
   * @param repoPath Repository path
   * @param headCommit Commit hash
   * @param branch Branch name
   * @returns Result indicating success or failure
   */
  private async logCommitDetails(
    repoPath: string,
    headCommit: string,
    branch: string
  ): Promise<Result<string, Error>> {
    try {
      logInfo(
        `Logging commit details for ${headCommit} in ${repoPath} on branch ${branch}`
      );

      // Get commit details
      const message = await getCommitMessage(repoPath, headCommit);
      const commitDate = new Date().toISOString();
      const author = await getCommitAuthorDetails(repoPath, headCommit);

      // Get repository name
      let repoName;
      try {
        repoName = await getRepoNameFromRemote(repoPath);
      } catch (error) {
        repoName = path.basename(repoPath);
        logInfo(`Using directory name as repo name: ${repoName}`);
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
      logInfo(`Writing log to: ${trackingFilePath}`);

      if (!validatePath(trackingFilePath)) {
        return failure(new Error("Invalid tracking file path."));
      }

      try {
        ensureDirectoryExists(path.dirname(trackingFilePath));
      } catch (err) {
        return failure(new Error(`Failed to ensure directory exists: ${err}`));
      }

      try {
        await appendToFile(trackingFilePath, logMessage);
        logInfo(`Successfully logged commit details to ${this.logFile}`);
      } catch (err) {
        return failure(new Error(`Failed to write to ${this.logFile}: ${err}`));
      }

      // Emit event for commit processed with info needed for potential push
      const commitInfo = {
        logFilePath: this.logFilePath,
        trackingFilePath,
        repoName,
        commitHash: headCommit,
      };

      this.emit(RepositoryEvent.COMMIT_PROCESSED, commitInfo, trackingFilePath);

      // Emit push requested event for CommandManager to handle
      this.emit(
        RepositoryEvent.PUSH_REQUESTED,
        this.logFilePath,
        trackingFilePath
      );

      logInfo("Commit logging complete");
      return success(trackingFilePath);
    } catch (err) {
      this.handleError(
        err,
        `logging commit details for ${headCommit}`,
        ErrorType.FILESYSTEM
      );
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
    logInfo(
      `Directly processing commit ${commitHash} in ${repoPath} on branch ${branch}`
    );

    if (!commitHash) {
      const error = new Error("Cannot process commit: No commit hash provided");
      this.handleError(
        error,
        "processing commit directly",
        ErrorType.REPOSITORY,
        true
      );
      return failure(error);
    }

    if (!repoPath) {
      const error = new Error(
        "Cannot process commit: No repository path provided"
      );
      this.handleError(
        error,
        "processing commit directly",
        ErrorType.REPOSITORY,
        true
      );
      return failure(error);
    }

    try {
      // Get commit details
      const message = await getCommitMessage(repoPath, commitHash);
      const author = await getCommitAuthorDetails(repoPath, commitHash);
      const date = new Date().toISOString();

      let repoName;
      try {
        repoName = await getRepoNameFromRemote(repoPath);
      } catch (error) {
        repoName = path.basename(repoPath);
      }

      const commit: Commit = {
        hash: commitHash,
        message,
        author,
        date,
        branch,
        repoName,
        repoPath,
      };

      // Log the commit details
      const result = await this.logCommitDetails(repoPath, commitHash, branch);
      if (result.isFailure()) {
        return failure(result.error);
      }

      // Update the last processed commit
      this.lastProcessedCommit = commitHash;
      await this.context.globalState.update("lastProcessedCommit", commitHash);

      logInfo(`Direct commit processing complete for ${commitHash}`);
      return success(commit);
    } catch (error) {
      this.handleError(
        error,
        `directly processing commit ${commitHash}`,
        ErrorType.GIT_OPERATION,
        true
      );
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get status information for a repository
   * @param repo The repository to get status for
   * @returns Result containing repository status
   */
  public getRepositoryStatus(repo: any): Result<RepositoryStatus, Error> {
    try {
      if (!repo || !repo.rootUri) {
        return failure(new Error("Invalid repository"));
      }

      const repoPath = repo.rootUri.fsPath;
      const status = this.repositories.get(repoPath);

      if (!status) {
        return failure(
          new Error(`Repository status not found for: ${repoPath}`)
        );
      }

      return success(status);
    } catch (error) {
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
      let repoName;
      try {
        repoName = await getRepoNameFromRemote(repoPath);
      } catch (error) {
        repoName = path.basename(repoPath);
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
      logError(`Error updating repository status: ${error}`);
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
      logInfo(`Found ${activeRepos.length} active repositories`);

      let setupCount = 0;
      let errorCount = 0;

      activeRepos.forEach((repo: any) => {
        const repoPath = repo.rootUri?.fsPath || "unknown";
        logInfo(`Setting up listener for repository: ${repoPath}`);

        // Add a direct check of the repository state
        if (!repo.state.onDidChange) {
          logError(
            `Repository state.onDidChange is not available for ${repoPath}`
          );
          errorCount++;
          return;
        }

        const debouncedOnDidChange = debounce(async () => {
          logInfo(`Repository change detected in ${repoPath}`);
          const result = await this.updateRepositoryStatus(repo);
          if (result.isFailure()) {
            logError(
              `Failed to update repository status: ${result.error.message}`
            );
          }
        }, 300);

        try {
          const listener = repo.state.onDidChange(debouncedOnDidChange);
          const disposable = { dispose: () => listener.dispose() };
          this.repoListeners.set(repoPath, disposable);
          this.disposableManager.register(disposable);
          logInfo(`Successfully registered change listener for ${repoPath}`);
          setupCount++;
        } catch (error) {
          logError(
            `Failed to register change listener for ${repoPath}: ${error}`
          );
          errorCount++;
        }
      });

      // Register for repository changes (new repositories added)
      try {
        logInfo("Setting up listener for new repositories");
        const repoChangeListener = api.onDidOpenRepository((repo: any) => {
          logInfo(
            `New repository opened: ${repo.rootUri?.fsPath || "unknown"}`
          );
          const result = this.setupRepositoryListener(repo);
          if (result.isFailure()) {
            logError(
              `Failed to setup repository listener: ${result.error.message}`
            );
          }
        });

        const disposable = { dispose: () => repoChangeListener.dispose() };
        this.disposableManager.register(disposable);
        this.repoListeners.set("global", disposable);
        logInfo("Successfully registered listener for new repositories");
      } catch (error) {
        logError(`Failed to register listener for new repositories: ${error}`);
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
          logError(
            `Failed to update repository status: ${result.error.message}`
          );
        }
      }, 300);

      try {
        const listener = repo.state.onDidChange(debouncedOnDidChange);
        const disposable = { dispose: () => listener.dispose() };
        this.repoListeners.set(repoPath, disposable);
        this.disposableManager.register(disposable);
        logInfo(`Added listener for repository: ${repoPath}`);
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
      logInfo("Setting up direct commit monitoring");

      // Function to process repositories periodically
      const processRepositories = () => {
        const repos = api.repositories;
        repos.forEach((repo: any) => {
          this.updateRepositoryStatus(repo).catch((error) => {
            logError(`Error monitoring repository: ${error}`);
          });
        });
      };

      // Set up an interval to periodically check repositories
      const intervalId = setInterval(processRepositories, 5000);

      // Register the interval for cleanup
      this.disposableManager.register({
        dispose: () => clearInterval(intervalId),
      });

      logInfo("Direct commit monitoring set up successfully");
      return success(true);
    } catch (error) {
      logError(`Failed to set up direct commit monitoring: ${error}`);
      this.emit(RepositoryEvent.ERROR, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private setupConfigChangeListener(): void {
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("commitTracker")) {
        const updatedConfig =
          vscode.workspace.getConfiguration("commitTracker");
        this.logFilePath = updatedConfig.get<string>("logFilePath")!;
        this.logFile = updatedConfig.get<string>("logFile")!;
        this.excludedBranches =
          updatedConfig.get<string[]>("excludedBranches")!;

        // Emit configuration updated event with the new values
        this.emit(RepositoryEvent.CONFIG_UPDATED, {
          logFilePath: this.logFilePath,
          logFile: this.logFile,
          excludedBranches: this.excludedBranches,
        });

        logInfo("Configuration updated");
      }
    });

    this.context.subscriptions.push(configListener);
    this.disposableManager.register({
      dispose: () => configListener.dispose(),
    });
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
   * Check for unpushed commits and emit events
   * @returns Result indicating if there are unpushed commits
   */
  public async checkUnpushedCommits(): Promise<Result<boolean, Error>> {
    try {
      if (!this.logFilePath) {
        return failure(new Error("Log file path not configured"));
      }

      const hasUnpushedCommits = await this.gitService.hasUnpushedCommits(
        this.logFilePath
      );

      // Emit event with unpushed commits status
      this.emit(RepositoryEvent.UNPUSHED_COMMITS_CHANGED, hasUnpushedCommits);

      return success(hasUnpushedCommits);
    } catch (error) {
      this.emit(RepositoryEvent.ERROR, error);
      return failure(error instanceof Error ? error : new Error(String(error)));
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
