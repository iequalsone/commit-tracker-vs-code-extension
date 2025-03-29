import * as vscode from "vscode";
import * as fs from "fs";
import {
  IConfigurationService,
  ConfigurationChangeEvent,
} from "./interfaces/IConfigurationService";
import { ILogService } from "./interfaces/ILogService";
import { Result, success, failure } from "../utils/results";

/**
 * Default implementation of ConfigurationService using VS Code's configuration API
 */
export class ConfigurationService implements IConfigurationService {
  private readonly configPrefix: string;
  private readonly logService?: ILogService;
  private readonly _onDidChangeConfiguration =
    new vscode.EventEmitter<ConfigurationChangeEvent>();

  /**
   * Event emitted when configuration changes
   */
  public readonly onDidChangeConfiguration =
    this._onDidChangeConfiguration.event;

  /**
   * Cache of configuration values
   * Used to detect changes and emit change events
   */
  private configCache: Map<string, any> = new Map();

  /**
   * Creates a new ConfigurationService
   * @param configPrefix The extension's configuration prefix (e.g. "commitTracker")
   * @param logService Optional log service for logging
   */
  constructor(configPrefix: string, logService?: ILogService) {
    this.configPrefix = configPrefix;
    this.logService = logService;

    // Initialize the cache with current values
    this.initializeCache();

    // Set up configuration change listener
    vscode.workspace.onDidChangeConfiguration(
      this.handleConfigChange.bind(this)
    );

    if (this.logService) {
      this.logService.info("ConfigurationService initialized");
    }
  }

  /**
   * Initialize the configuration cache with current values
   */
  private initializeCache(): void {
    const config = vscode.workspace.getConfiguration(this.configPrefix);

    // Cache commonly accessed settings
    this.configCache.set("enabled", config.get("enabled"));
    this.configCache.set("logFilePath", config.get("logFilePath"));
    this.configCache.set("logFile", config.get("logFile"));
    this.configCache.set("excludedBranches", config.get("excludedBranches"));
    this.configCache.set(
      "updateFrequencyMinutes",
      config.get("updateFrequencyMinutes")
    );
    this.configCache.set("showNotifications", config.get("showNotifications"));

    if (this.logService) {
      this.logService.info("Configuration cache initialized");
    }
  }

  /**
   * Handle configuration changes and emit events
   * @param event VS Code configuration change event
   */
  private handleConfigChange(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration(this.configPrefix)) {
      return;
    }

    const config = vscode.workspace.getConfiguration(this.configPrefix);

    // Check each cached setting for changes
    this.configCache.forEach((cachedValue, key) => {
      const fullKey = `${this.configPrefix}.${key}`;

      if (event.affectsConfiguration(fullKey)) {
        const newValue = config.get(key);

        // Only emit if the value has actually changed
        if (JSON.stringify(cachedValue) !== JSON.stringify(newValue)) {
          // Emit change event
          this._onDidChangeConfiguration.fire({
            key,
            oldValue: cachedValue,
            newValue,
          });

          // Update cache
          this.configCache.set(key, newValue);

          if (this.logService) {
            this.logService.info(`Configuration changed: ${key}`);
          }
        }
      }
    });
  }

  /**
   * Get a configuration value
   * @param section Configuration setting key
   * @param defaultValue Default value if setting is not found
   */
  public get<T>(section: string, defaultValue?: T): T {
    const config = vscode.workspace.getConfiguration(this.configPrefix);
    return config.get<T>(section, defaultValue as T);
  }

  /**
   * Update a configuration value
   * @param section Configuration setting key
   * @param value New value to set
   * @param target Configuration scope to update
   */
  public async update(
    section: string,
    value: any,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.configPrefix);

    try {
      await config.update(section, value, target);

      // Cache the new value (will be updated by handleConfigChange too, but this is more immediate)
      this.configCache.set(section, value);

      if (this.logService) {
        this.logService.info(
          `Updated configuration: ${section} = ${JSON.stringify(value)}`
        );
      }
    } catch (error) {
      if (this.logService) {
        this.logService.error(
          `Failed to update configuration: ${section}`,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Check if a particular configuration has been changed
   * @param event VS Code configuration change event
   * @param section Configuration setting to check
   */
  public affectsConfiguration(
    event: vscode.ConfigurationChangeEvent,
    section: string
  ): boolean {
    return event.affectsConfiguration(`${this.configPrefix}.${section}`);
  }

  /**
   * Validate required configuration settings
   * @param requiredSettings Array of required setting keys
   * @returns True if all required settings are valid, false otherwise
   */
  public validateRequiredSettings(requiredSettings: string[]): boolean {
    if (this.logService) {
      this.logService.info("Validating required configuration settings");
    }

    const config = vscode.workspace.getConfiguration(this.configPrefix);

    // Check that all required settings exist
    for (const setting of requiredSettings) {
      if (config.get(setting) === undefined) {
        if (this.logService) {
          this.logService.warn(`Missing required configuration: ${setting}`);
        }
        return false;
      }
    }

    // Validate log file path exists if specified
    const logFilePath = this.getTrackerRepoPath();
    if (logFilePath) {
      try {
        if (!fs.existsSync(logFilePath)) {
          if (this.logService) {
            this.logService.warn(
              `Log directory does not exist: ${logFilePath}`
            );
          }
          return false;
        }
      } catch (error) {
        if (this.logService) {
          this.logService.error(`Error checking log directory: ${error}`);
        }
        return false;
      }
    } else {
      // Log file path is required but not set
      return false;
    }

    return true;
  }

  /**
   * Check if the extension is properly configured
   * @returns True if the extension is configured, false otherwise
   */
  public isConfigured(): boolean {
    // List of required settings
    const requiredSettings = [
      "enabled",
      "updateFrequencyMinutes",
      "showNotifications",
      "logFilePath",
      "logFile",
    ];

    return this.validateRequiredSettings(requiredSettings);
  }

  /**
   * Get the tracking repository path
   * @returns Path to the tracking repository or undefined if not set
   */
  public getTrackerRepoPath(): string | undefined {
    return this.get<string>("logFilePath");
  }

  /**
   * Get the tracking log file name
   * @returns Name of the tracking log file or undefined if not set
   */
  public getTrackerLogFile(): string | undefined {
    return this.get<string>("logFile");
  }

  /**
   * Get excluded branches
   * @returns Array of branch names to exclude from tracking
   */
  public getExcludedBranches(): string[] {
    return this.get<string[]>("excludedBranches", []);
  }

  /**
   * Get a typed configuration object with multiple settings
   * @param sections Configuration sections to retrieve
   * @returns Object containing the requested configuration values
   */
  public getConfigObject<T extends Record<string, any>>(sections: string[]): T {
    const result = {} as T;
    const config = vscode.workspace.getConfiguration(this.configPrefix);

    for (const section of sections) {
      (result as Record<string, any>)[section] = config.get(section);
    }

    return result;
  }

  /**
   * Check if the extension is enabled
   * @returns True if enabled, false otherwise
   */
  public isEnabled(): boolean {
    return this.get<boolean>("enabled", false);
  }

  /**
   * Set the enabled state of the extension
   * @param enabled True to enable, false to disable
   */
  public async setEnabled(enabled: boolean): Promise<void> {
    await this.update("enabled", enabled);
  }

  /**
   * Check if notifications are enabled
   * @returns True if notifications are enabled, false otherwise
   */
  public showNotifications(): boolean {
    return this.get<boolean>("showNotifications", true);
  }

  /**
   * Get the update frequency in minutes
   * @returns Update frequency in minutes
   */
  public getUpdateFrequency(): number {
    return this.get<number>("updateFrequencyMinutes", 5);
  }

  /**
   * Set the update frequency in minutes
   * @param minutes Update frequency in minutes
   */
  public async setUpdateFrequency(minutes: number): Promise<void> {
    await this.update("updateFrequencyMinutes", minutes);
  }

  /**
   * Set the tracking repository path and log file
   * @param repoPath Path to the tracking repository
   * @param logFile Name of the log file
   */
  public async setTrackerRepo(
    repoPath: string,
    logFile: string
  ): Promise<Result<void, Error>> {
    try {
      // Validate the path exists
      if (!fs.existsSync(repoPath)) {
        return failure(
          new Error(`Repository path does not exist: ${repoPath}`)
        );
      }

      await this.update("logFilePath", repoPath);
      await this.update("logFile", logFile);

      return success(undefined);
    } catch (error) {
      if (this.logService) {
        this.logService.error(`Failed to set tracker repository: ${error}`);
      }
      return failure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Set excluded branches
   * @param branches Array of branch names to exclude
   */
  public async setExcludedBranches(branches: string[]): Promise<void> {
    await this.update("excludedBranches", branches);
  }
}
