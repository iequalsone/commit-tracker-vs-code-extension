import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GitService } from "../../services/gitService";
import {
  ensureDirectoryExists,
  appendToFile,
  validatePath,
} from "../../services/fileService";
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
  private logService?: ILogService;

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
    logService?: ILogService
  ) {
    super();
    this.context = context;
    this.statusManager = statusManager;
    this.commandManager = commandManager;
    this.gitService = gitService;
    this.logService = logService;
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
      this.logService?.info("Initializing repository manager");

      // Emit event before initialization starts
      this.emit(RepositoryEvent.TRACKING_STARTED);

      try {
        await this.gitService?.pullChanges(this.logFilePath);
        this.logService?.info(
          "Successfully pulled latest changes from tracking repository"
        );
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

      this.logService?.info(
        "Git API available, setting up repository listeners"
      );

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
      this.logService?.info("Processing current repository states");
      try {
        const repos = api.repositories;
        for (const repo of repos) {
          if (repo.state.HEAD?.commit) {
            const result = await this.updateRepositoryStatus(repo);
            if (result.isFailure()) {
              this.logService?.error(
                `Error updating repository status: ${result.error.message}`
              );
            }
          }
        }
      } catch (error) {
        this.logService?.error(
          `Error processing current repositories: ${error}`
        );
      }

      // Emit event after successful initialization
      this.emit(RepositoryEvent.TRACKING_STARTED, api.repositories.length);

      // Emit an event that the repository has been initialized
      this.emit(RepositoryEvent.REPOSITORY_INITIALIZED, true);

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
      let repoName = path.basename(repoPath);

      // Emit status update for processing
      this.notifyCommitProcessing(repoName, commitHash);

      // Show processing status
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
        this.logService?.error(`Error checking log file: ${error}`);
      }

      // Get commit details
      const message =
        (await this.gitService?.getCommitMessage(repoPath, commitHash)) ||
        "No commit message";
      const author =
        (await this.gitService?.getCommitAuthorDetails(repoPath, commitHash)) ||
        "Unknown author";
      const date = new Date().toISOString();

      repoName =
        (await this.gitService?.getRepoNameFromRemote(repoPath)) ??
        path.basename(repoPath);

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

      this.invalidateCache();

      this.notifyCommitSuccess(repoName, commitHash);

      return success(commit);
    } catch (error) {
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
        `Logging commit details for ${headCommit} in ${repoPath} on branch ${branch}`
      );

      // Get commit details
      const message = await this.gitService?.getCommitMessage(
        repoPath,
        headCommit
      );
      const commitDate = new Date().toISOString();
      const author = await this.gitService?.getCommitAuthorDetails(
        repoPath,
        headCommit
      );

      // Get repository name
      let repoName;
      try {
        repoName = await this.gitService?.getRepoNameFromRemote(repoPath);
      } catch (error) {
        repoName = path.basename(repoPath);
        this.logService?.info(`Using directory name as repo name: ${repoName}`);
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
      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath") || "";
      const logFile = config.get<string>("logFile") || "commit-tracker.log";
      const trackingFilePath = path.join(logFilePath, logFile);

      this.logService?.info(`Writing log to: ${trackingFilePath}`);

      try {
        if (!validatePath(trackingFilePath)) {
          throw new Error("Invalid tracking file path.");
        }
        ensureDirectoryExists(path.dirname(trackingFilePath));
        this.logService?.info(`Ensured directory exists: ${logFilePath}`);
      } catch (err) {
        return failure(new Error(`Failed to ensure directory exists: ${err}`));
      }

      try {
        await appendToFile(trackingFilePath, logMessage);
        this.logService?.info(
          `Successfully logged commit details to ${logFile}`
        );
      } catch (err) {
        return failure(new Error(`Failed to write to ${logFile}: ${err}`));
      }

      // Request push operation via CommandManager
      this.requestPush(logFilePath, trackingFilePath);

      // Notify via status update
      this.sendStatusUpdate({
        type: "info",
        message: "Commit logged successfully",
        details: `${repoName}: ${headCommit.substring(0, 7)}`,
        duration: 3000,
      });

      return success(trackingFilePath);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleError(
        error,
        "Logging commit details",
        ErrorType.FILESYSTEM,
        true
      );
      return failure(error);
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
    this.logService?.info(
      `Directly processing commit ${commitHash} in ${repoPath} on branch ${branch}`
    );

    if (!commitHash) {
      return failure(new Error("No commit hash provided"));
    }

    if (!repoPath) {
      return failure(new Error("No repository path provided"));
    }

    try {
      if (!this.gitService) {
        return failure(new Error("GitService not available"));
      }

      // Get commit details using the GitService
      const message =
        (await this.gitService.getCommitMessage(repoPath, commitHash)) ||
        "No commit message";
      const author = await this.gitService.getCommitAuthorDetails(
        repoPath,
        commitHash
      );
      const commitDate = new Date().toISOString();
      const repoName = await this.gitService.getRepoNameFromRemote(repoPath);

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

      // Log the commit details using the internal method
      const result = await this.logCommitDetails(repoPath, commitHash, branch);
      if (result.isFailure()) {
        return failure(result.error);
      }

      // Update last processed commit in global state
      this.lastProcessedCommit = commitHash;
      await this.context.globalState.update("lastProcessedCommit", commitHash);

      // Emit that a commit was processed
      this.emit(RepositoryEvent.COMMIT_PROCESSED, commit, result.value);

      return success(commit);
    } catch (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      this.handleError(
        errorObj,
        `Failed to directly process commit ${commitHash}`,
        ErrorType.REPOSITORY,
        true
      );
      this.emit(RepositoryEvent.COMMIT_FAILED, repoPath, commitHash, errorObj);
      return failure(errorObj);
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

      if (!headCommit) {
        this.handleError(
          new Error("No HEAD commit found"),
          "processing repository change",
          ErrorType.REPOSITORY
        );
        return;
      }

      // Skip excluded branches
      if (this.excludedBranches.includes(branch)) {
        return;
      }

      // Always invalidate this repository's status cache on change
      const repoStatusKey = repoPath;
      if (this.cache.repositoryStatus.has(repoStatusKey)) {
        this.cache.repositoryStatus.delete(repoStatusKey);
      }

      // Check if commit was already processed
      if (this.lastProcessedCommit === headCommit) {
        return;
      }

      // Process the commit
      await this.processCommit(repo, headCommit);

      // After processing a commit, invalidate relevant caches
      this.invalidateCache("commitHistory");
      this.invalidateCache("statistics");
      this.invalidateCache("unpushedCommits");

      // Emit status change event
      this.emit(RepositoryEvent.REPOSITORY_STATUS_CHANGED, repoPath);
    } catch (error) {
      this.handleError(
        error,
        "processing repository change",
        ErrorType.REPOSITORY
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
        hasUnpushedCommits = await this.gitService.hasUnpushedCommits(
          logFilePath
        );
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
    try {
      // Check cache first
      const now = Date.now();
      if (
        this.cache.commitHistory &&
        now - this.cache.commitHistory.timestamp < this.CACHE_TTL.COMMIT_HISTORY
      ) {
        // If requested limit is larger than what we have cached, get fresh data
        if (limit <= this.cache.commitHistory.data.length) {
          return success(this.cache.commitHistory.data.slice(0, limit));
        }
      }

      const config = vscode.workspace.getConfiguration("commitTracker");
      const logFilePath = config.get<string>("logFilePath");
      const logFile = config.get<string>("logFile", "commit-tracker.log");

      if (!logFilePath) {
        return failure(new Error("Log file path not configured"));
      }

      const fullPath = path.join(logFilePath, logFile);

      if (!fs.existsSync(fullPath)) {
        return success([]);
      }

      // Read and parse the log file
      const content = await fs.promises.readFile(fullPath, "utf8");
      const commitBlocks = content
        .split("\n\n")
        .filter((block) => block.trim());

      const commits: Commit[] = [];
      for (const block of commitBlocks) {
        try {
          const lines = block.split("\n");
          if (lines.length < 6) continue;

          const hash = lines[0].replace("Commit: ", "").trim();
          const message = lines[1].replace("Message: ", "").trim();
          const author = lines[2].replace("Author: ", "").trim();
          const date = lines[3].replace("Date: ", "").trim();
          const branch = lines[4].replace("Branch: ", "").trim();
          const repoName = lines[5].replace("Repository: ", "").trim();
          const repoPath = lines[6].replace("Repository Path: ", "").trim();

          commits.push({
            hash,
            message,
            author,
            date,
            branch,
            repoName,
            repoPath,
          });

          if (commits.length >= limit) break;
        } catch (err) {
          // Skip malformed entries
          continue;
        }
      }

      // Store in cache
      this.cache.commitHistory = {
        data: commits,
        timestamp: now,
      };

      return success(commits);
    } catch (error) {
      this.handleError(error, "getting commit history", ErrorType.FILESYSTEM);
      return failure(error instanceof Error ? error : new Error(String(error)));
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
          repoName = remoteName || repoName;
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
      let repoName: string;
      try {
        repoName =
          (await this.gitService?.getRepoNameFromRemote(repoPath)) ||
          path.basename(repoPath);
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

        this.logService?.info("Configuration updated");
      }
    });

    this.context.subscriptions.push(configListener);
    this.disposableManager.register({
      dispose: () => configListener.dispose(),
    });
  }

  /**
   * Load configuration from workspace settings
   * Emits configuration update event instead of direct UI updates
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration("commitTracker");
    this.logFilePath = config.get<string>("logFilePath") || "";
    this.logFile = config.get<string>("logFile") || "commit-tracker.log";
    this.excludedBranches = config.get<string[]>("excludedBranches") || [];

    // Emit config updated event
    this.emit(RepositoryEvent.CONFIG_UPDATED, {
      logFilePath: this.logFilePath,
      logFile: this.logFile,
      excludedBranches: this.excludedBranches,
    });

    // Add this status update
    const configValid = !!this.logFilePath && !!this.logFile;
    if (configValid) {
      this.notifyNormalStatus();
    } else {
      this.emit(RepositoryEvent.STATUS_UPDATE, {
        type: "warning",
        message: "Configuration incomplete",
        details: "Setup needed for CommitTracker",
      });
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
   * Check for unpushed commits and emit event instead of directly updating UI
   * @returns Result indicating if there are unpushed commits
   */
  public async checkUnpushedCommits(): Promise<Result<boolean, Error>> {
    try {
      if (!this.gitService) {
        return failure(new Error("GitService not available"));
      }

      // Use the GitService abstraction
      const hasUnpushed = await this.gitService.hasUnpushedCommits(
        this.logFilePath
      );

      // Update cache
      this.cache.unpushedCommits = {
        data: {
          count: hasUnpushed ? 1 : 0,
          commitHashes: [],
          needsPush: hasUnpushed,
        },
        timestamp: Date.now() + this.CACHE_TTL.UNPUSHED_COMMITS,
      };

      // Emit event for the UI to pick up
      this.emit(RepositoryEvent.UNPUSHED_COMMITS_CHANGED, hasUnpushed);

      return success(hasUnpushed);
    } catch (error) {
      // If error, assume there might be unpushed commits to be safe
      this.emit(RepositoryEvent.UNPUSHED_COMMITS_CHANGED, true);
      return failure(new Error(`Failed to check unpushed commits: ${error}`));
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
    this.emit(RepositoryEvent.SETUP_REQUESTED);
  }

  /**
   * Request display of repository information
   */
  public requestRepositoryInfo(): void {
    this.emit(RepositoryEvent.REPOSITORY_INFO_REQUESTED);
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
