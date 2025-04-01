import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { RepositoryManager } from "../repository/repositoryManager";
import { GitService } from "../../services/gitService";
import { ILogService } from "../../services/interfaces/ILogService";
import { IConfigurationService } from "../../services/interfaces/IConfigurationService";
import { IFileSystemService } from "../../services/interfaces/IFileSystemService";
import {
  INotificationService,
  NotificationPriority,
} from "../../services/interfaces/INotificationService";

/**
 * Manages the extension setup process and configuration validation
 */
export class SetupManager {
  private readonly context: vscode.ExtensionContext;
  private readonly logService: ILogService;
  private readonly configurationService?: IConfigurationService;
  private gitService?: GitService;
  private repositoryManager?: RepositoryManager;
  private fileSystemService?: IFileSystemService;
  private notificationService?: INotificationService;

  constructor(
    context: vscode.ExtensionContext,
    logService: ILogService,
    configurationService?: IConfigurationService,
    gitService?: GitService,
    repositoryManager?: RepositoryManager,
    fileSystemService?: IFileSystemService,
    notificationService?: INotificationService
  ) {
    this.context = context;
    this.logService = logService;
    this.configurationService = configurationService;
    this.gitService = gitService;
    this.repositoryManager = repositoryManager;
    this.fileSystemService = fileSystemService;
    this.notificationService = notificationService;
  }

  /**
   * Connect to the repository manager after initialization
   * @param repositoryManager The repository manager instance
   */
  public connectRepositoryManager(repositoryManager: RepositoryManager): void {
    this.repositoryManager = repositoryManager;
    this.logService.info("SetupManager connected to RepositoryManager");
  }

  /**
   * Connect to the Git service for repository operations
   * @param gitService The Git service instance
   */
  public connectGitService(gitService: GitService): void {
    this.gitService = gitService;
    this.logService.info("SetupManager connected to GitService");
  }

  /**
   * Validates the current configuration
   * @returns True if configuration is valid, false otherwise
   */
  public async validateConfiguration(): Promise<boolean> {
    this.logService.info("Validating configuration");

    if (this.configurationService) {
      return this.configurationService.isConfigured();
    }

    // Legacy implementation if configurationService isn't provided
    const config = vscode.workspace.getConfiguration("commitTracker");

    // Required settings validation
    const requiredSettings = [
      "enabled",
      "updateFrequencyMinutes",
      "showNotifications",
      "logFilePath",
      "logFile",
    ];

    // Check that all required settings exist
    for (const setting of requiredSettings) {
      if (config.get(setting) === undefined) {
        this.logService.warn(`Missing required configuration: ${setting}`);
        return false;
      }
    }

    // Validate log file path exists
    const logFilePath = config.get<string>("logFilePath");
    if (logFilePath) {
      if (!this.fileSystemService) {
        try {
          const fs = require("fs");
          if (!fs.existsSync(logFilePath)) {
            this.logService.warn(
              `Log directory does not exist: ${logFilePath}`
            );
            return false;
          }
        } catch (error) {
          this.logService.error(`Error checking log directory: ${error}`);
          return false;
        }
      } else {
        // Use FileSystemService if available
        try {
          const pathExistsResult = await this.fileSystemService.exists(
            logFilePath
          );
          if (pathExistsResult.isFailure() || !pathExistsResult.value) {
            this.logService.warn(
              `Log directory does not exist: ${logFilePath}`
            );
            return false;
          }
        } catch (error) {
          this.logService.error(`Error checking log directory: ${error}`);
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Handles first time setup for the extension
   * @returns Promise that resolves to true if setup was completed successfully
   */
  public async runSetupWizard(): Promise<boolean> {
    this.logService.info("Running setup wizard");

    try {
      // Show welcome message using notification service if available
      let startSetup: string | undefined;

      if (this.notificationService) {
        startSetup = await this.notificationService.info(
          "Welcome to Commit Tracker! Do you want to set up the extension now?",
          { priority: NotificationPriority.HIGH },
          "Yes",
          "No"
        );
      } else {
        // Fallback to direct vscode API
        startSetup = await vscode.window.showInformationMessage(
          "Welcome to Commit Tracker! Do you want to set up the extension now?",
          "Yes",
          "No"
        );
      }

      if (startSetup !== "Yes") {
        this.logService.info("Setup wizard cancelled by user");
        return false;
      }

      // Select log folder
      const folderPath = await this.selectLogFolder();
      if (!folderPath) {
        this.logService.info("No log folder selected, setup cancelled");
        return false;
      }

      // Initialize the repository
      const repoInitialized = await this.initializeRepository(folderPath);
      if (!repoInitialized) {
        this.showNotification(
          "error",
          "Failed to initialize repository. Check logs for details."
        );
        return false;
      }

      // Create default configuration
      const config = vscode.workspace.getConfiguration("commitTracker");
      await config.update("enabled", true, vscode.ConfigurationTarget.Global);
      await config.update(
        "updateFrequencyMinutes",
        5,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "showNotifications",
        true,
        vscode.ConfigurationTarget.Global
      );

      // Mark setup as complete
      await this.context.globalState.update("setupComplete", true);

      this.showNotification(
        "info",
        "Commit Tracker setup completed successfully!"
      );
      return true;
    } catch (error) {
      this.logService.error("Setup wizard failed", error);
      this.showNotification("error", "Failed to complete Commit Tracker setup");
      return false;
    }
  }

  /**
   * Allows user to select a folder for commit tracking logs
   * @returns Promise resolving to the selected folder path or undefined if canceled
   */
  public async selectLogFolder(): Promise<string | undefined> {
    this.logService.info("Prompting user to select log folder");

    // Show folder picker
    const options: vscode.OpenDialogOptions = {
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Commit Tracker Log Folder",
    };

    const folderUri = await vscode.window.showOpenDialog(options);
    if (!folderUri || folderUri.length === 0) {
      this.logService.info("No folder selected");
      return undefined;
    }

    return folderUri[0].fsPath;
  }

  /**
   * Reset the setup state for the extension
   * @returns Promise resolving when reset is complete
   */
  public async resetSetup(): Promise<void> {
    this.logService.info("Resetting extension setup");

    // Clear the setup complete flag
    await this.context.globalState.update("setupComplete", false);

    // Optionally clear some configuration values
    const config = vscode.workspace.getConfiguration("commitTracker");
    await config.update("enabled", false, vscode.ConfigurationTarget.Global);

    this.showNotification("info", "Setup has been reset");
    this.logService.info("Setup has been reset");
  }

  /**
   * Checks if setup has been completed
   * @returns True if setup is complete, false otherwise
   */
  public isSetupComplete(): boolean {
    return !!this.context.globalState.get<boolean>("setupComplete");
  }

  /**
   * Verify if git repository is properly configured for the tracker
   * @param repoPath Path to check
   * @returns Promise resolving to true if setup is valid
   */
  public async verifyGitSetup(repoPath: string): Promise<boolean> {
    try {
      if (this.fileSystemService) {
        // Use FileSystemService
        const gitDirResult = await this.fileSystemService.exists(
          path.join(repoPath, ".git")
        );

        if (gitDirResult.isFailure()) {
          this.logService.error(
            `Error checking if git directory exists: ${gitDirResult.error}`
          );
          return false;
        }

        if (!gitDirResult.value) {
          this.logService.warn(`${repoPath} is not a Git repository`);
          return false;
        }

        return true;
      } else {
        // Fallback to direct fs usage
        const fs = require("fs");
        const path = require("path");

        // Check if it's a git repository
        if (!fs.existsSync(path.join(repoPath, ".git"))) {
          this.logService.warn(`${repoPath} is not a Git repository`);
          return false;
        }

        // More git validation could be added here
        return true;
      }
    } catch (error) {
      this.logService.error(`Error verifying Git setup: ${error}`);
      return false;
    }
  }

  /**
   * Initialize a repository for tracking
   * @param folderPath Path to the repository folder
   * @returns Promise resolving to true if initialization was successful
   */
  public async initializeRepository(folderPath: string): Promise<boolean> {
    try {
      if (!this.fileSystemService) {
        this.logService.error("No file system service available");
        return false;
      }

      this.logService.info(`Initializing repository at ${folderPath}`);

      // Check if folder exists
      const folderExistsResult = await this.fileSystemService.exists(
        folderPath
      );
      if (folderExistsResult.isFailure()) {
        this.logService.error(
          "Failed to check if folder exists",
          folderExistsResult.error
        );
        return false;
      }

      if (!folderExistsResult.value) {
        this.showNotification("error", `Folder ${folderPath} does not exist`);
        return false;
      }

      // Create default log file if it doesn't exist
      const logFile = "commit-tracker.log";
      const logFilePath = path.join(folderPath, logFile);

      const fileExistsResult = await this.fileSystemService.exists(logFilePath);
      if (fileExistsResult.isFailure() || !fileExistsResult.value) {
        // Create initial log file
        const initialContent =
          "# Commit Tracker Log\n\nThis file tracks your Git commits.\n\n";
        const writeResult = await this.fileSystemService.writeFile(
          logFilePath,
          initialContent
        );

        if (writeResult.isFailure()) {
          this.logService.error("Failed to create log file", writeResult.error);
          return false;
        }
      }

      // Initialize Git repository if needed
      const isGitRepo = await this.gitService?.isGitRepository(folderPath);
      if (!isGitRepo) {
        const repoInitialized = await this.initializeGitRepo(folderPath);
        if (!repoInitialized) {
          this.showNotification("error", "Failed to initialize Git repository");
          return false;
        }
      }

      // Update configuration
      if (this.configurationService) {
        const result = await this.configurationService.setTrackerRepo(
          folderPath,
          logFile
        );
        if (result.isFailure()) {
          this.logService.error("Failed to update configuration", result.error);
          return false;
        }
      } else {
        // Fallback to direct configuration update
        const config = vscode.workspace.getConfiguration("commitTracker");
        await config.update(
          "logFilePath",
          folderPath,
          vscode.ConfigurationTarget.Global
        );
        await config.update(
          "logFile",
          logFile,
          vscode.ConfigurationTarget.Global
        );
      }

      this.showNotification("info", `Repository initialized at ${folderPath}`);
      return true;
    } catch (error) {
      this.logService.error("Failed to initialize repository", error);
      return false;
    }
  }

  /**
   * Initialize a Git repository with initial commit
   * @param folderPath Path to initialize Git repository
   * @returns Promise resolving to true if successful
   */
  public async initializeGitRepo(folderPath: string): Promise<boolean> {
    try {
      this.logService.info(`Initializing Git repository at ${folderPath}`);

      // If GitService is available, use it
      if (this.gitService) {
        try {
          await this.gitService.executeGitCommand(folderPath, "init");
          await this.gitService.executeGitCommand(
            folderPath,
            'config user.name "Commit Tracker"'
          );
          await this.gitService.executeGitCommand(
            folderPath,
            'config user.email "commit.tracker@example.com"'
          );

          // Create initial file if needed
          const readmePath = path.join(folderPath, "README.md");
          if (!fs.existsSync(readmePath)) {
            fs.writeFileSync(
              readmePath,
              "# Commit Tracker Repository\n\nThis repository tracks your commits across projects.\n",
              "utf8"
            );
          }

          await this.gitService.executeGitCommand(folderPath, "add .");
          await this.gitService.executeGitCommand(
            folderPath,
            'commit -m "Initial commit for Commit Tracker"'
          );

          this.logService.info(
            `Git repository successfully initialized at ${folderPath}`
          );
          return true;
        } catch (error) {
          this.logService.error(
            `Error using GitService to initialize repository: ${error}`
          );
          // Fall back to terminal approach if GitService fails
        }
      }

      // Fall back to terminal approach if GitService isn't available or failed
      const terminal = vscode.window.createTerminal({
        name: "Commit Tracker Setup",
        cwd: folderPath,
      });

      terminal.show();
      terminal.sendText("git init");
      terminal.sendText('git config user.name "Commit Tracker"');
      terminal.sendText('git config user.email "commit.tracker@example.com"');
      terminal.sendText("touch README.md");
      terminal.sendText('echo "# Commit Tracker Repository" > README.md');
      terminal.sendText('echo "" >> README.md');
      terminal.sendText(
        'echo "This repository tracks your commits across projects." >> README.md'
      );
      terminal.sendText("git add README.md");
      terminal.sendText('git commit -m "Initial commit for Commit Tracker"');
      terminal.sendText("exit");

      // Wait a bit for the terminal operations to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      this.logService.info(
        `Git repository initialized at ${folderPath} using terminal`
      );
      return true;
    } catch (error) {
      this.logService.error(`Error initializing Git repository: ${error}`);
      vscode.window.showErrorMessage(
        `Failed to initialize Git repository: ${error}`
      );
      return false;
    }
  }

  /**
   * Helper method to show notifications using NotificationService if available,
   * otherwise fall back to vscode.window
   */
  private showNotification(
    type: "info" | "warning" | "error",
    message: string,
    ...actions: string[]
  ): Promise<string | undefined> {
    if (this.notificationService) {
      switch (type) {
        case "info":
          return this.notificationService.info(message, {}, ...actions);
        case "warning":
          return this.notificationService.warn(message, {}, ...actions);
        case "error":
          return this.notificationService.error(message, {}, ...actions);
      }
    } else {
      // Fallback to direct vscode API
      switch (type) {
        case "info":
          return Promise.resolve(
            vscode.window.showInformationMessage(message, ...actions)
          );
        case "warning":
          return Promise.resolve(
            vscode.window.showWarningMessage(message, ...actions)
          );
        case "error":
          return Promise.resolve(
            vscode.window.showErrorMessage(message, ...actions)
          );
      }
    }
  }
}
