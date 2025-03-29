import * as vscode from "vscode";
import * as fs from "fs";
import {
  IConfigurationService,
  ConfigurationChangeEvent,
} from "./interfaces/IConfigurationService";
import { ILogService } from "./interfaces/ILogService";
import { Result, success, failure } from "../utils/results";
import path from "path";

/**
 * Default implementation of ConfigurationService using VS Code's configuration API
 */
export class ConfigurationService implements IConfigurationService {
  private readonly configPrefix: string;
  private readonly logService?: ILogService;
  private readonly _onDidChangeConfiguration =
    new vscode.EventEmitter<ConfigurationChangeEvent>();

  /**
   * Cache of configuration values
   * Used to detect changes and emit change events
   */
  private configCache: Map<string, any> = new Map();

  /**
   * Default configuration values
   * Used for validation and resetting to defaults
   */
  private readonly defaultValues: Record<string, any> = {
    enabled: false,
    logFilePath: "",
    logFile: "commit-tracker.log",
    excludedBranches: [],
    updateFrequencyMinutes: 5,
    showNotifications: true,
    enableDebugLogging: false,
    enableFileLogging: false,
    allowedAuthors: [],
  };

  /**
   * Event emitted when configuration changes
   */
  public readonly onDidChangeConfiguration =
    this._onDidChangeConfiguration.event;

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
   * Enhanced validation for required settings with custom validation
   * @param requiredSettings Array of required setting keys
   * @param customValidators Optional map of setting keys to validator functions
   * @returns True if all required settings are valid, false otherwise
   */
  public validateRequiredSettings(
    requiredSettings: string[],
    customValidators?: Map<string, (value: any) => boolean>
  ): boolean {
    if (this.logService) {
      this.logService.info("Validating required configuration settings");
    }

    const config = vscode.workspace.getConfiguration(this.configPrefix);

    // Check that all required settings exist and have non-undefined values
    for (const setting of requiredSettings) {
      if (config.get(setting) === undefined) {
        if (this.logService) {
          this.logService.warn(`Missing required configuration: ${setting}`);
        }
        return false;
      }

      // If a custom validator is provided for this setting, use it
      if (customValidators && customValidators.has(setting)) {
        const validator = customValidators.get(setting)!;
        const value = config.get(setting);

        if (!validator(value)) {
          if (this.logService) {
            this.logService.warn(
              `Validation failed for ${setting}: ${JSON.stringify(value)}`
            );
          }
          return false;
        }
      }
    }

    // If logFilePath is one of the required settings, perform special validation
    if (requiredSettings.includes("logFilePath")) {
      return this.validatePath("logFilePath");
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

    // Create custom validators for numeric values
    const customValidators = new Map<string, (value: any) => boolean>();
    customValidators.set(
      "updateFrequencyMinutes",
      (value: number) => value >= 1 && value <= 60
    );

    return (
      this.validateRequiredSettings(requiredSettings, customValidators) &&
      this.validateGitRepository("logFilePath")
    );
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

  /**
   * Reset all configuration to default values
   * @returns Promise that resolves when reset is complete
   */
  public async resetToDefaults(): Promise<void> {
    if (this.logService) {
      this.logService.info("Resetting configuration to defaults");
    }

    const config = vscode.workspace.getConfiguration(this.configPrefix);

    for (const [key, value] of Object.entries(this.defaultValues)) {
      try {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
      } catch (error) {
        if (this.logService) {
          this.logService.error(
            `Failed to reset ${key} to default value`,
            error
          );
        }
      }
    }

    // Re-initialize cache after resetting
    this.initializeCache();

    if (this.logService) {
      this.logService.info("Configuration reset to defaults complete");
    }
  }

  /**
   * Get all configuration settings
   * @returns Object containing all configuration values
   */
  public getAllSettings(): Record<string, any> {
    const config = vscode.workspace.getConfiguration(this.configPrefix);
    const result: Record<string, any> = {};

    // Get all configuration keys
    for (const key of Object.keys(this.defaultValues)) {
      result[key] = config.get(key);
    }

    return result;
  }

  /**
   * Validate a specific configuration setting
   * @param key Configuration key to validate
   * @param validator Function to validate the value
   * @returns True if valid, false otherwise
   */
  public validateSetting<T>(
    key: string,
    validator: (value: T) => boolean
  ): boolean {
    const value = this.get<T>(key);

    if (value === undefined) {
      return false;
    }

    try {
      return validator(value);
    } catch (error) {
      if (this.logService) {
        this.logService.error(`Validation error for ${key}`, error);
      }
      return false;
    }
  }

  /**
   * Refresh the configuration cache
   * Useful when configuration may have changed externally
   */
  public refreshCache(): void {
    if (this.logService) {
      this.logService.debug("Refreshing configuration cache");
    }
    this.initializeCache();
  }

  /**
   * Validate that a path exists and is accessible
   * @param pathKey Configuration key for the path setting
   * @returns True if path is valid and accessible, false otherwise
   */
  public validatePath(pathKey: string): boolean {
    if (this.logService) {
      this.logService.info(`Validating path for setting: ${pathKey}`);
    }

    const path = this.get<string>(pathKey);
    if (!path) {
      if (this.logService) {
        this.logService.warn(`Path setting ${pathKey} is empty`);
      }
      return false;
    }

    try {
      if (!fs.existsSync(path)) {
        if (this.logService) {
          this.logService.warn(`Path does not exist: ${path}`);
        }
        return false;
      }

      // Check if path is accessible
      fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch (error) {
      if (this.logService) {
        this.logService.error(`Error validating path ${path}:`, error);
      }
      return false;
    }
  }

  /**
   * Validate numeric range
   * @param key Configuration key for the numeric setting
   * @param min Minimum allowed value (inclusive)
   * @param max Maximum allowed value (inclusive)
   * @returns True if value is within range, false otherwise
   */
  public validateNumericRange(key: string, min: number, max: number): boolean {
    if (this.logService) {
      this.logService.info(`Validating numeric range for setting: ${key}`);
    }

    const value = this.get<number>(key);
    if (value === undefined) {
      return false;
    }

    const isValid = value >= min && value <= max;

    if (!isValid && this.logService) {
      this.logService.warn(
        `Value ${value} for ${key} is outside range [${min}, ${max}]`
      );
    }

    return isValid;
  }

  /**
   * Validate array values against allowed options
   * @param key Configuration key for the array setting
   * @param allowedValues Array of allowed values
   * @returns True if all values in the array are allowed, false otherwise
   */
  public validateArrayValues<T>(key: string, allowedValues: T[]): boolean {
    if (this.logService) {
      this.logService.info(`Validating array values for setting: ${key}`);
    }

    const values = this.get<T[]>(key, []);

    // If array is empty, consider it valid (since it has no invalid values)
    if (values.length === 0) {
      return true;
    }

    const allValid = values.every((value) => allowedValues.includes(value));

    if (!allValid && this.logService) {
      const invalidValues = values.filter(
        (value) => !allowedValues.includes(value)
      );
      this.logService.warn(
        `Invalid values found for ${key}: ${JSON.stringify(invalidValues)}`
      );
    }

    return allValid;
  }

  /**
   * Validate git repository configuration
   * @param repoPathKey Configuration key for the repository path
   * @returns True if path is a valid git repository, false otherwise
   */
  public validateGitRepository(repoPathKey: string): boolean {
    if (this.logService) {
      this.logService.info(
        `Validating git repository for setting: ${repoPathKey}`
      );
    }

    const repoPath = this.get<string>(repoPathKey);
    if (!repoPath) {
      if (this.logService) {
        this.logService.warn(`Repository path setting ${repoPathKey} is empty`);
      }
      return false;
    }

    try {
      // Check if directory exists
      if (!fs.existsSync(repoPath)) {
        if (this.logService) {
          this.logService.warn(`Repository path does not exist: ${repoPath}`);
        }
        return false;
      }

      // Check if it's a git repository by looking for .git directory
      const gitDir = path.join(repoPath, ".git");
      if (!fs.existsSync(gitDir)) {
        if (this.logService) {
          this.logService.warn(
            `Not a git repository (missing .git directory): ${repoPath}`
          );
        }
        return false;
      }

      return true;
    } catch (error) {
      if (this.logService) {
        this.logService.error(
          `Error validating git repository ${repoPath}:`,
          error
        );
      }
      return false;
    }
  }

  // ...existing code...

  /**
   * Validate the entire configuration and return detailed results
   * @returns Object with validation results for each setting
   */
  public validateAllSettings(): Record<
    string,
    { valid: boolean; message?: string }
  > {
    if (this.logService) {
      this.logService.info("Validating all configuration settings");
    }

    const results: Record<string, { valid: boolean; message?: string }> = {};

    // Required settings validation
    const requiredSettings = [
      "enabled",
      "updateFrequencyMinutes",
      "showNotifications",
      "logFilePath",
      "logFile",
    ];

    for (const setting of requiredSettings) {
      const value = this.get(setting);
      if (value === undefined) {
        results[setting] = {
          valid: false,
          message: `Missing required setting: ${setting}`,
        };
      } else {
        results[setting] = { valid: true };
      }
    }

    // Specific validations

    // Validate logFilePath
    if (results["logFilePath"]?.valid) {
      const logFilePath = this.get<string>("logFilePath");
      if (!fs.existsSync(logFilePath!)) {
        results["logFilePath"] = {
          valid: false,
          message: `Path does not exist: ${logFilePath}`,
        };
      } else if (!this.validateGitRepository("logFilePath")) {
        results["logFilePath"] = {
          valid: false,
          message: `Not a git repository: ${logFilePath}`,
        };
      }
    }

    // Validate updateFrequencyMinutes
    if (results["updateFrequencyMinutes"]?.valid) {
      const frequency = this.get<number>("updateFrequencyMinutes");
      if (frequency! < 1 || frequency! > 60) {
        results["updateFrequencyMinutes"] = {
          valid: false,
          message: `Update frequency must be between 1 and 60 minutes, got ${frequency}`,
        };
      }
    }

    // Validate excludedBranches if present
    const excludedBranches = this.get<string[]>("excludedBranches", []);
    results["excludedBranches"] = { valid: true };

    // Validate enableDebugLogging if present
    const enableDebugLogging = this.get<boolean>("enableDebugLogging", false);
    results["enableDebugLogging"] = { valid: true };

    // Validate enableFileLogging if present
    const enableFileLogging = this.get<boolean>("enableFileLogging", false);
    results["enableFileLogging"] = { valid: true };

    // Log the validation results
    if (this.logService) {
      const failedSettings = Object.entries(results)
        .filter(([_, result]) => !result.valid)
        .map(([setting, result]) => `${setting}: ${result.message}`);

      if (failedSettings.length > 0) {
        this.logService.warn(
          `Configuration validation failed for: ${failedSettings.join(", ")}`
        );
      } else {
        this.logService.info("All configuration settings are valid");
      }
    }

    return results;
  }

  /**
   * Check if the extension is properly configured with more detail
   * @returns Object with overall validation status and detailed results
   */
  public validateConfiguration(): {
    isValid: boolean;
    results: Record<string, { valid: boolean; message?: string }>;
  } {
    const results = this.validateAllSettings();
    const isValid = Object.values(results).every((result) => result.valid);

    return {
      isValid,
      results,
    };
  }
}
