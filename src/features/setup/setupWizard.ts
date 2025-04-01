import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { LogService } from "../../services/logService";
import { SetupManager } from "./setupManager";
import { IFileSystemService } from "../../services/interfaces/IFileSystemService";
import {
  INotificationService,
  NotificationPriority,
} from "../../services/interfaces/INotificationService";

/**
 * Provides a guided setup process for the Commit Tracker extension
 */
export class SetupWizard {
  private readonly context: vscode.ExtensionContext;
  private readonly logService: LogService;
  private fileSystemService?: IFileSystemService;
  private notificationService?: INotificationService;
  private setupManager: SetupManager;

  constructor(
    context: vscode.ExtensionContext,
    logService: LogService,
    fileSystemService?: IFileSystemService,
    notificationService?: INotificationService
  ) {
    this.context = context;
    this.logService = logService;
    this.fileSystemService = fileSystemService;
    this.notificationService = notificationService;

    this.setupManager = new SetupManager(
      context,
      logService,
      undefined,
      undefined,
      undefined,
      fileSystemService,
      notificationService
    );
  }

  /**
   * Run the complete setup wizard process
   * @returns Promise resolving to true if setup was successful
   */
  public async run(): Promise<boolean> {
    this.logService.info("Starting setup wizard");

    // Show welcome message using notification service if available
    let startSetup: string | undefined;

    if (this.notificationService) {
      startSetup = await this.notificationService.info(
        "Welcome to Commit Tracker! This wizard will help you set up the extension.",
        { priority: NotificationPriority.HIGH },
        "Continue",
        "Cancel"
      );
    } else {
      startSetup = await vscode.window.showInformationMessage(
        "Welcome to Commit Tracker! This wizard will help you set up the extension.",
        "Continue",
        "Cancel"
      );
    }

    if (startSetup !== "Continue") {
      this.logService.info("Setup canceled by user");
      return false;
    }

    // Step 1: Select log repository
    const repoSetup = await this.setupLogRepository();
    if (!repoSetup) {
      return false;
    }

    // Step 2: Configure notification preferences
    await this.configureNotifications();

    // Step 3: Configure update frequency
    await this.configureUpdateFrequency();

    // Mark setup as complete
    await this.context.globalState.update("setupComplete", true);

    this.showNotification(
      "info",
      "Commit Tracker setup completed successfully!"
    );
    return true;
  }

  /**
   * Set up the log repository
   */
  private async setupLogRepository(): Promise<boolean> {
    let selection: string | undefined;

    const options = ["Select existing folder", "Create new folder"];

    if (this.notificationService) {
      selection = await this.notificationService.showWithCallback(
        "How would you like to set up your commit tracking logs?",
        "info",
        (action) => {
          // Callback is handled in the method itself
        },
        { useMarkdown: true },
        ...options
      );
    } else {
      selection = await vscode.window.showQuickPick(options, {
        placeHolder: "How would you like to set up your commit tracking logs?",
      });
    }

    if (!selection) {
      return false;
    }

    let folderPath: string | undefined;

    if (selection === "Select existing folder") {
      // Show folder picker
      folderPath = await this.selectExistingFolder();
      if (!folderPath) {
        return false;
      }

      // Verify if it's a git repo already
      if (!(await this.setupManager.verifyGitSetup(folderPath))) {
        this.showNotification(
          "warning",
          "Selected folder is not a Git repository. Would you like to initialize it?",
          "Yes",
          "No"
        ).then(async (response) => {
          if (response === "Yes") {
            await this.initializeGitRepo(folderPath!);
          } else {
            this.showNotification(
              "error",
              "Cannot continue without a Git repository."
            );
            return false;
          }
        });
      }
    } else {
      // Create new folder option
      folderPath = await this.createNewFolder();
      if (!folderPath) {
        return false;
      }

      // Initialize Git repository
      await this.initializeGitRepo(folderPath);
    }

    // Update configuration with the selected/created path
    const config = vscode.workspace.getConfiguration("commitTracker");
    await config.update(
      "logFilePath",
      folderPath,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "logFile",
      "commit-tracker.log",
      vscode.ConfigurationTarget.Global
    );

    return true;
  }

  /**
   * Initialize a new Git repository in the given folder
   */
  private async initializeGitRepo(folderPath: string): Promise<boolean> {
    try {
      this.logService.info(`Initializing Git repository at ${folderPath}`);

      // Delegate to SetupManager's implementation
      const result = await this.setupManager.initializeGitRepo(folderPath);

      if (result) {
        // Only create the commit log file if the repo was initialized successfully
        // Create initial file using FileSystemService if available
        if (this.fileSystemService) {
          const initialContent =
            "# Commit Tracker Log\n\nInitial setup: " +
            new Date().toISOString() +
            "\n";

          const writeResult = await this.fileSystemService.writeFile(
            path.join(folderPath, "commit-tracker.log"),
            initialContent
          );

          if (writeResult.isFailure()) {
            this.logService.error(
              "Failed to create initial log file",
              writeResult.error
            );
            this.showNotification("error", "Failed to create initial log file");
            // Continue anyway since the repo is initialized
          }
        } else {
          // Fallback to direct fs usage
          try {
            fs.writeFileSync(
              path.join(folderPath, "commit-tracker.log"),
              "# Commit Tracker Log\n\nInitial setup: " +
                new Date().toISOString() +
                "\n"
            );
          } catch (err) {
            this.logService.error("Failed to create initial log file", err);
            this.showNotification("error", "Failed to create initial log file");
            // Continue anyway since the repo is initialized
          }
        }

        // Add the commit-tracker.log file to the repo
        // Use terminal approach for consistency with SetupManager
        const terminal = vscode.window.createTerminal({
          name: "Commit Tracker Setup",
          cwd: folderPath,
        });

        terminal.show();
        terminal.sendText("git add commit-tracker.log");
        terminal.sendText('git commit -m "Add commit tracking log file"');
        terminal.sendText("exit");

        // Wait for terminal operations to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));

        this.showNotification(
          "info",
          `Git repository initialized at ${folderPath}`
        );
      }

      return result;
    } catch (error) {
      this.logService.error(`Error initializing Git repository: ${error}`);
      this.showNotification(
        "error",
        `Failed to initialize Git repository: ${error}`
      );
      return false;
    }
  }

  /**
   * Select an existing folder for commit logs
   */
  private async selectExistingFolder(): Promise<string | undefined> {
    const options: vscode.OpenDialogOptions = {
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Folder for Commit Tracker Logs",
    };

    const folderUri = await vscode.window.showOpenDialog(options);
    if (!folderUri || folderUri.length === 0) {
      return undefined;
    }

    return folderUri[0].fsPath;
  }

  /**
   * Create a new folder for commit logs
   */
  private async createNewFolder(): Promise<string | undefined> {
    // First select a parent directory
    const parentOptions: vscode.OpenDialogOptions = {
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select Parent Folder",
    };

    const parentUri = await vscode.window.showOpenDialog(parentOptions);
    if (!parentUri || parentUri.length === 0) {
      return undefined;
    }

    // Ask for folder name
    const folderName = await vscode.window.showInputBox({
      prompt: "Enter folder name for Commit Tracker logs",
      placeHolder: "commit-tracker-logs",
    });

    if (!folderName) {
      return undefined;
    }

    // Create the folder
    const fullPath = path.join(parentUri[0].fsPath, folderName);

    if (this.fileSystemService) {
      const createDirResult = await this.fileSystemService.ensureDirectory(
        fullPath
      );

      if (createDirResult.isFailure()) {
        this.logService.error(
          `Error creating folder: ${createDirResult.error}`
        );
        vscode.window.showErrorMessage(
          `Failed to create folder: ${createDirResult.error}`
        );
        return undefined;
      }
    } else {
      // Fallback to direct fs operations
      try {
        const fs = require("fs");
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
        }
      } catch (error) {
        this.logService.error(`Error creating folder: ${error}`);
        vscode.window.showErrorMessage(`Failed to create folder: ${error}`);
        return undefined;
      }
    }

    return fullPath;
  }

  /**
   * Configure notification preferences
   */
  private async configureNotifications(): Promise<void> {
    let selection: string | undefined;
    const options = ["Yes", "No"];

    if (this.notificationService) {
      selection = await this.notificationService.info(
        "Would you like to receive notifications when commits are tracked?",
        { useMarkdown: true },
        ...options
      );
    } else {
      selection = await vscode.window.showQuickPick(options, {
        placeHolder:
          "Would you like to receive notifications when commits are tracked?",
      });
    }

    const config = vscode.workspace.getConfiguration("commitTracker");
    await config.update(
      "showNotifications",
      selection === "Yes",
      vscode.ConfigurationTarget.Global
    );
  }

  /**
   * Configure update frequency
   */
  private async configureUpdateFrequency(): Promise<void> {
    const options = [
      "1 minute",
      "5 minutes",
      "10 minutes",
      "30 minutes",
      "60 minutes",
    ];

    let selection: string | undefined;

    if (this.notificationService) {
      selection = await this.notificationService.info(
        "How often should Commit Tracker check for commits?",
        { useMarkdown: true },
        ...options
      );
    } else {
      selection = await vscode.window.showQuickPick(options, {
        placeHolder: "How often should Commit Tracker check for commits?",
      });
    }

    // Parse the selection to get just the number
    let minutes = 5; // Default
    if (selection) {
      const match = selection.match(/(\d+)/);
      if (match && match[1]) {
        minutes = parseInt(match[1], 10);
      }
    }

    const config = vscode.workspace.getConfiguration("commitTracker");
    await config.update(
      "updateFrequencyMinutes",
      minutes,
      vscode.ConfigurationTarget.Global
    );
  }

  /**
   * Reset all setup settings
   */
  public async reset(): Promise<void> {
    await this.context.globalState.update("setupComplete", false);
    this.showNotification("info", "Commit Tracker setup has been reset.");
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
