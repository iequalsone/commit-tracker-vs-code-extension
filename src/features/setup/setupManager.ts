import * as vscode from "vscode";
import { LogService } from "../../services/logService";

/**
 * Manages the extension setup process and configuration validation
 */
export class SetupManager {
  private readonly context: vscode.ExtensionContext;
  private readonly logService: LogService;

  constructor(context: vscode.ExtensionContext, logService: LogService) {
    this.context = context;
    this.logService = logService;
  }

  /**
   * Validates the current configuration
   * @returns True if configuration is valid, false otherwise
   */
  public validateConfiguration(): boolean {
    this.logService.info("Validating configuration");

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
      try {
        const fs = require("fs");
        if (!fs.existsSync(logFilePath)) {
          this.logService.warn(`Log directory does not exist: ${logFilePath}`);
          return false;
        }
      } catch (error) {
        this.logService.error(`Error checking log directory: ${error}`);
        return false;
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
      // Show welcome message
      const startSetup = await vscode.window.showInformationMessage(
        "Welcome to Commit Tracker! Do you want to set up the extension now?",
        "Yes",
        "No"
      );

      if (startSetup !== "Yes") {
        return false;
      }

      // Select log folder
      const folderPath = await this.selectLogFolder();
      if (!folderPath) {
        this.logService.info("Setup canceled - no folder selected");
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

      // Mark setup as complete
      await this.context.globalState.update("setupComplete", true);

      vscode.window.showInformationMessage(
        "Commit Tracker setup completed successfully!"
      );
      return true;
    } catch (error) {
      this.logService.error("Setup wizard failed", error);
      vscode.window.showErrorMessage("Failed to complete Commit Tracker setup");
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
      const fs = require("fs");
      const path = require("path");

      // Check if it's a git repository
      if (!fs.existsSync(path.join(repoPath, ".git"))) {
        this.logService.warn(`${repoPath} is not a Git repository`);
        return false;
      }

      // More git validation could be added here
      return true;
    } catch (error) {
      this.logService.error(`Error verifying Git setup: ${error}`);
      return false;
    }
  }
}
