import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { LogService } from "../../services/logService";
import { SetupManager } from "./setupManager";

/**
 * Provides a guided setup process for the Commit Tracker extension
 */
export class SetupWizard {
  private readonly context: vscode.ExtensionContext;
  private readonly logService: LogService;
  private setupManager: SetupManager;

  constructor(context: vscode.ExtensionContext, logService: LogService) {
    this.context = context;
    this.logService = logService;
    this.setupManager = new SetupManager(context, logService);
  }

  /**
   * Run the complete setup wizard process
   * @returns Promise resolving to true if setup was successful
   */
  public async run(): Promise<boolean> {
    this.logService.info("Starting setup wizard");

    // Show welcome message
    const startSetup = await vscode.window.showInformationMessage(
      "Welcome to Commit Tracker! This wizard will help you set up the extension.",
      "Continue",
      "Cancel"
    );

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

    vscode.window.showInformationMessage(
      "Commit Tracker setup completed successfully!"
    );
    return true;
  }

  /**
   * Set up the log repository
   */
  private async setupLogRepository(): Promise<boolean> {
    const options = ["Select existing folder", "Create new folder"];
    const selection = await vscode.window.showQuickPick(options, {
      placeHolder: "How would you like to set up your commit tracking logs?",
    });

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
        const initGit = await vscode.window.showInformationMessage(
          "This folder is not a Git repository. Would you like to initialize it?",
          "Yes",
          "No"
        );

        if (initGit === "Yes") {
          await this.initializeGitRepo(folderPath);
        } else {
          vscode.window.showWarningMessage(
            "A Git repository is required for Commit Tracker to function properly."
          );
          return false;
        }
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

      // Create a new terminal for Git operations
      const terminal = vscode.window.createTerminal({
        name: "Commit Tracker Setup",
        cwd: folderPath,
      });

      terminal.show();
      terminal.sendText("git init");
      terminal.sendText('git config user.name "Commit Tracker"');
      terminal.sendText('git config user.email "commit.tracker@example.com"');
      terminal.sendText("touch commit-tracker.log");
      terminal.sendText("git add commit-tracker.log");
      terminal.sendText('git commit -m "Initial commit for Commit Tracker"');
      terminal.sendText("exit");

      // We can't easily know when the terminal is done, so we just wait a bit
      await new Promise((resolve) => setTimeout(resolve, 2000));

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
    try {
      fs.mkdirSync(fullPath, { recursive: true });
      return fullPath;
    } catch (error) {
      this.logService.error(`Error creating folder: ${error}`);
      vscode.window.showErrorMessage(`Failed to create folder: ${error}`);
      return undefined;
    }
  }

  /**
   * Configure notification preferences
   */
  private async configureNotifications(): Promise<void> {
    const options = ["Yes", "No"];
    const selection = await vscode.window.showQuickPick(options, {
      placeHolder:
        "Would you like to receive notifications when commits are tracked?",
    });

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

    const selection = await vscode.window.showQuickPick(options, {
      placeHolder: "How often should Commit Tracker check for commits?",
    });

    // Parse the selection to get just the number
    let minutes = 5; // Default
    if (selection) {
      const match = selection.match(/^(\d+)/);
      if (match) {
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
    vscode.window.showInformationMessage(
      "Commit Tracker setup has been reset."
    );
  }
}
