import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  getCommitAuthorDetails,
  getCommitMessage,
  getRepoNameFromRemote,
  pullChanges,
  pushChanges,
  pushChangesWithShellScript,
  pushChangesWithSpawn,
  pushChangesWithHiddenTerminal,
} from "../services/gitService";
import {
  ensureDirectoryExists,
  appendToFile,
  validatePath,
} from "../services/fileService";
import { logInfo, logError } from "../utils/logger";
import { debounce } from "../utils/debounce";
import { DisposableManager } from "../utils/DisposableManager";

export class RepositoryManager {
  private disposableManager: DisposableManager;
  private logFilePath: string;
  private logFile: string;
  private excludedBranches: string[];
  private context: vscode.ExtensionContext;
  private lastProcessedCommit: string | null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.disposableManager = DisposableManager.getInstance();
    this.lastProcessedCommit = context.globalState.get(
      "lastProcessedCommit",
      null
    );

    // Load configuration
    const config = vscode.workspace.getConfiguration("commitTracker");
    this.logFilePath = config.get<string>("logFilePath")!;
    this.logFile = config.get<string>("logFile")!;
    this.excludedBranches = config.get<string[]>("excludedBranches")!;
  }

  public async initialize(): Promise<boolean> {
    try {
      logInfo("Initializing repository manager");

      await pullChanges(this.logFilePath);
      logInfo("Successfully pulled latest changes from tracking repository");
    } catch (err) {
      logError(`Failed to pull changes from tracking repository: ${err}`);
    }

    const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
    if (!gitExtension) {
      logError(
        "Git extension is not available. Please ensure Git is installed and the Git extension is enabled."
      );
      return false;
    }

    const api = gitExtension.getAPI(1);
    if (!api) {
      logError(
        "Failed to get Git API. Please ensure the Git extension is enabled."
      );
      return false;
    }

    logInfo("Git API available, setting up repository listeners");

    // Set up both monitoring methods for redundancy
    this.setupRepositoryListeners(api);
    this.setupDirectCommitMonitoring(api); // Add direct monitoring
    this.setupConfigChangeListener();

    // Process current commits immediately
    logInfo("Processing current repository states");
    try {
      const repos = api.repositories;
      for (const repo of repos) {
        if (repo.state.HEAD?.commit) {
          logInfo(
            `Processing current commit: ${repo.state.HEAD.commit} in ${repo.rootUri.fsPath}`
          );
          await this.processCurrentRepository(repo);
        }
      }
    } catch (error) {
      logError(`Error processing current repositories: ${error}`);
    }

    return true;
  }

  private setupRepositoryListeners(api: any): void {
    const activeRepos = api.repositories.filter((repo: any) => repo.state.HEAD);

    logInfo(`Found ${activeRepos.length} active repositories`);

    if (activeRepos.length === 0) {
      logError(
        "No active repositories found with HEAD. This may prevent commit detection."
      );
    }

    activeRepos.forEach(
      (repo: {
        state: {
          HEAD: { commit: any; name: any };
          onDidChange: (arg0: () => void) => void;
        };
        rootUri: { fsPath: any };
      }) => {
        const repoPath = repo.rootUri?.fsPath || "unknown";
        const headCommit = repo.state.HEAD?.commit || "unknown";
        const branchName = repo.state.HEAD?.name || "unknown";

        logInfo(`Setting up listener for repository: ${repoPath}`);
        logInfo(`Current HEAD commit: ${headCommit}, Branch: ${branchName}`);

        // Add a direct check of the repository state
        if (!repo.state.onDidChange) {
          logError(
            `Repository state.onDidChange is not available for ${repoPath}. Cannot monitor commits.`
          );
          return;
        }

        const debouncedOnDidChange = debounce(async () => {
          const newHeadCommit = repo.state.HEAD?.commit || "unknown";
          const newBranchName = repo.state.HEAD?.name || "unknown";

          logInfo(`Repository change detected in ${repoPath}`);
          logInfo(
            `Previous commit: ${headCommit}, New commit: ${newHeadCommit}`
          );
          logInfo(
            `Previous branch: ${branchName}, New branch: ${newBranchName}`
          );

          // Only process if the commit has actually changed
          if (newHeadCommit !== headCommit && newHeadCommit !== "unknown") {
            logInfo(`Commit has changed, processing: ${newHeadCommit}`);
            await this.processRepositoryChange(repo);
          } else {
            logInfo(
              `Repository change did not include a commit change, skipping processing`
            );
          }
        }, 300);

        try {
          const listener = repo.state.onDidChange(debouncedOnDidChange);
          logInfo(`Successfully registered change listener for ${repoPath}`);

          const disposableListener = { dispose: () => listener };
          this.context.subscriptions.push(disposableListener);
          this.disposableManager.register(disposableListener);
        } catch (error) {
          logError(
            `Failed to register change listener for ${repoPath}: ${error}`
          );
        }
      }
    );

    // Register for repository changes (new repositories added)
    try {
      logInfo("Setting up listener for new repositories");
      const repoChangeListener = api.onDidOpenRepository((repo: any) => {
        logInfo(`New repository opened: ${repo.rootUri?.fsPath || "unknown"}`);
        // Setup listener for this new repository
        const debouncedOnDidChange = debounce(async () => {
          await this.processRepositoryChange(repo);
        }, 300);

        try {
          const listener = repo.state.onDidChange(debouncedOnDidChange);
          const disposableListener = { dispose: () => listener };
          this.context.subscriptions.push(disposableListener);
          this.disposableManager.register(disposableListener);
          logInfo(
            `Added listener for new repository: ${
              repo.rootUri?.fsPath || "unknown"
            }`
          );
        } catch (error) {
          logError(`Failed to add listener for new repository: ${error}`);
        }
      });

      this.context.subscriptions.push({
        dispose: () => repoChangeListener.dispose(),
      });
      this.disposableManager.register({
        dispose: () => repoChangeListener.dispose(),
      });
      logInfo("Successfully registered listener for new repositories");
    } catch (error) {
      logError(`Failed to register listener for new repositories: ${error}`);
    }
  }

  /**
   * Process the current repository for the manual logging command
   * @param repo The repository to process
   * @returns A promise that resolves when the repository has been processed
   */
  public async processCurrentRepository(repo: any): Promise<void> {
    logInfo("Manually processing repository");

    if (!repo) {
      logError("Repository object is null or undefined");
      return;
    }

    if (!repo.state) {
      logError("Repository state is null or undefined");
      return;
    }

    if (!repo.state.HEAD) {
      logError("Repository HEAD is null or undefined");
      return;
    }

    logInfo(
      `Repository info - Path: ${repo.rootUri?.fsPath || "unknown"}, Commit: ${
        repo.state.HEAD?.commit || "unknown"
      }, Branch: ${repo.state.HEAD?.name || "unknown"}`
    );

    // Use the existing processRepositoryChange method to handle the logic
    await this.processRepositoryChange(repo);

    logInfo("Manual repository processing complete");
  }

  private async processRepositoryChange(repo: any): Promise<void> {
    const headCommit = repo.state.HEAD?.commit;
    const branch = repo.state.HEAD?.name;
    const repoPath = repo.rootUri.fsPath;

    logInfo(
      `Repository change detected - Commit: ${headCommit}, Branch: ${branch}`
    );

    if (!headCommit) {
      logError(
        "No HEAD commit found. Please ensure the repository is in a valid state."
      );
      return;
    }

    // Skip excluded branches
    if (this.excludedBranches.includes(branch)) {
      logInfo(`Skipping logging for excluded branch: ${branch}`);
      return;
    }

    // Check if author is allowed
    const config = vscode.workspace.getConfiguration("commitTracker");
    const allowedAuthors = config.get<string[]>("allowedAuthors") || [];

    if (allowedAuthors.length > 0) {
      try {
        const author = await getCommitAuthorDetails(repoPath, headCommit);
        logInfo(`Commit author: ${author}`);

        if (!allowedAuthors.includes(author)) {
          logInfo(`Skipping commit from non-allowed author: ${author}`);
          return;
        }
      } catch (error) {
        logError(`Error checking commit author: ${error}`);
        return;
      }
    }

    // Check if commit was already processed
    // First, check against the last processed commit in memory
    if (this.lastProcessedCommit === headCommit) {
      logInfo(`Skipping already processed commit: ${headCommit}`);
      return;
    }

    // Then check the log file
    try {
      const logPath = path.join(this.logFilePath, this.logFile);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf8");
        if (logContent.includes(headCommit)) {
          logInfo(`Commit ${headCommit} already exists in log file, skipping`);
          return;
        }
      }
    } catch (error) {
      logError(`Error checking commits.log: ${error}`);
    }

    logInfo(`Processing new commit: ${headCommit}`);
    this.lastProcessedCommit = headCommit;
    await this.context.globalState.update("lastProcessedCommit", headCommit);

    await this.logCommitDetails(repoPath, headCommit, branch);
  }

  private async logCommitDetails(
    repoPath: string,
    headCommit: string,
    branch: string
  ): Promise<void> {
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

      try {
        if (!validatePath(trackingFilePath)) {
          throw new Error("Invalid tracking file path.");
        }
        ensureDirectoryExists(path.dirname(trackingFilePath));
        logInfo(`Ensured directory exists: ${this.logFilePath}`);
      } catch (err) {
        logError(`Failed to ensure directory exists: ${err}`);
        return;
      }

      try {
        await appendToFile(trackingFilePath, logMessage);
        logInfo(`Successfully logged commit details to ${this.logFile}`);
      } catch (err) {
        logError(`Failed to write to ${this.logFile}: ${err}`);
        return;
      }

      // Try to push changes
      try {
        // Show a notification about the successful log and ongoing push
        vscode.window.showInformationMessage(
          "Commit logged successfully. Pushing changes to tracking repository..."
        );

        // Push changes using the terminal
        await pushChangesWithShellScript(this.logFilePath, trackingFilePath);

        // Note: The terminal push is asynchronous, so we can't know when it completes
        logInfo("Push operation started in terminal");
      } catch (err) {
        logError(`Failed to start push operation: ${err}`);

        // Show a notification about unpushed changes
        vscode.window.showWarningMessage(
          "Commit logged successfully, but changes could not be pushed automatically. " +
            "Click on 'Unpushed Logs' in the status bar to push manually."
        );
      }

      logInfo("Commit logging complete");
    } catch (err) {
      logError(`Failed to log commit details: ${err}`);
    }
  }

  private setupConfigChangeListener(): void {
    const configListener = vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration("commitTracker")) {
          const updatedConfig =
            vscode.workspace.getConfiguration("commitTracker");
          this.logFilePath = updatedConfig.get<string>("logFilePath")!;
          this.logFile = updatedConfig.get<string>("logFile")!;
          this.excludedBranches =
            updatedConfig.get<string[]>("excludedBranches")!;
          logInfo("Configuration updated");
        }
      }
    );

    this.context.subscriptions.push(configListener);
    this.disposableManager.register({
      dispose: () => configListener.dispose(),
    });
  }

  public updateConfiguration(
    logFilePath: string,
    logFile: string,
    excludedBranches: string[]
  ): void {
    this.logFilePath = logFilePath;
    this.logFile = logFile;
    this.excludedBranches = excludedBranches;
  }

  // Add a new method for direct monitoring
  public setupDirectCommitMonitoring(api: any): void {
    try {
      logInfo("Setting up direct commit monitoring");

      // Function to process any existing repositories
      const processExistingRepositories = () => {
        const repos = api.repositories;
        logInfo(`Found ${repos.length} Git repositories`);

        repos.forEach((repo: any) => {
          logInfo(`Processing repository: ${repo.rootUri.fsPath}`);

          // Store the current HEAD commit
          let lastCommitSha = repo.state.HEAD?.commit;
          logInfo(`Current HEAD commit: ${lastCommitSha || "unknown"}`);

          // Set up an interval to check for new commits
          const intervalId = setInterval(async () => {
            try {
              const currentCommitSha = repo.state.HEAD?.commit;

              if (currentCommitSha && currentCommitSha !== lastCommitSha) {
                logInfo(
                  `Detected new commit: ${currentCommitSha} (previous: ${
                    lastCommitSha || "none"
                  })`
                );
                lastCommitSha = currentCommitSha;
                await this.processRepositoryChange(repo);
              }
            } catch (error) {
              logError(`Error in commit monitoring interval: ${error}`);
            }
          }, 5000); // Check every 5 seconds

          // Register the interval for cleanup
          this.disposableManager.register({
            dispose: () => clearInterval(intervalId),
          });
        });
      };

      // Process existing repositories immediately
      processExistingRepositories();

      // Set up listener for new repositories
      const repoOpenListener = api.onDidOpenRepository(() => {
        logInfo("New repository opened, updating monitoring");
        processExistingRepositories();
      });

      this.disposableManager.register({
        dispose: () => repoOpenListener.dispose(),
      });

      logInfo("Direct commit monitoring set up successfully");
    } catch (error) {
      logError(`Failed to set up direct commit monitoring: ${error}`);
    }
  }

  /**
   * Process a commit directly, bypassing most checks
   * @param repoPath Path to the repository
   * @param commitHash The commit hash to process
   * @param branch The branch name
   * @returns A promise that resolves when the commit has been processed
   */
  public async processCommitDirectly(
    repoPath: string,
    commitHash: string,
    branch: string
  ): Promise<void> {
    logInfo(
      `Directly processing commit ${commitHash} in ${repoPath} on branch ${branch}`
    );

    if (!commitHash) {
      logError("Cannot process commit: No commit hash provided");
      return;
    }

    if (!repoPath) {
      logError("Cannot process commit: No repository path provided");
      return;
    }

    try {
      // Skip all normal checks and directly log the commit
      await this.logCommitDetails(repoPath, commitHash, branch);

      // Update the last processed commit
      this.lastProcessedCommit = commitHash;
      await this.context.globalState.update("lastProcessedCommit", commitHash);

      logInfo(`Direct commit processing complete for ${commitHash}`);
    } catch (error) {
      logError(`Failed to directly process commit ${commitHash}: ${error}`);
      throw error;
    }
  }
}
