import * as vscode from "vscode";
import { Result } from "../../utils/results";

/**
 * Configuration change event properties
 */
export interface ConfigurationChangeEvent {
  key: string;
  oldValue: any;
  newValue: any;
}

/**
 * Service for managing extension configuration
 */
export interface IConfigurationService {
  /**
   * Event emitted when configuration changes
   */
  onDidChangeConfiguration: vscode.Event<ConfigurationChangeEvent>;

  /**
   * Get a configuration value
   * @param section Configuration setting key
   * @param defaultValue Default value if setting is not found
   */
  get<T>(section: string, defaultValue?: T): T;

  /**
   * Update a configuration value
   * @param section Configuration setting key
   * @param value New value to set
   * @param target Configuration scope to update
   */
  update(
    section: string,
    value: any,
    target?: vscode.ConfigurationTarget
  ): Promise<void>;

  /**
   * Check if a particular configuration has been changed
   * @param event VS Code configuration change event
   * @param section Configuration setting to check
   */
  affectsConfiguration(
    event: vscode.ConfigurationChangeEvent,
    section: string
  ): boolean;

  /**
   * Validate required configuration settings
   * @param requiredSettings Array of required setting keys
   * @returns True if all required settings are valid, false otherwise
   */
  validateRequiredSettings(requiredSettings: string[]): boolean;

  /**
   * Check if the extension is properly configured
   * @returns True if the extension is configured, false otherwise
   */
  isConfigured(): boolean;

  /**
   * Get the tracking repository path
   * @returns Path to the tracking repository or undefined if not set
   */
  getTrackerRepoPath(): string | undefined;

  /**
   * Get the tracking log file name
   * @returns Name of the tracking log file or undefined if not set
   */
  getTrackerLogFile(): string | undefined;

  /**
   * Get excluded branches
   * @returns Array of branch names to exclude from tracking
   */
  getExcludedBranches(): string[];

  /**
   * Get a typed configuration object with multiple settings
   * @param sections Configuration sections to retrieve
   * @returns Object containing the requested configuration values
   */
  getConfigObject<T extends Record<string, any>>(sections: string[]): T;

  /**
   * Check if the extension is enabled
   * @returns True if enabled, false otherwise
   */
  isEnabled(): boolean;

  /**
   * Set the enabled state of the extension
   * @param enabled True to enable, false to disable
   */
  setEnabled(enabled: boolean): Promise<void>;

  /**
   * Check if notifications are enabled
   * @returns True if notifications are enabled, false otherwise
   */
  showNotifications(): boolean;

  /**
   * Get the update frequency in minutes
   * @returns Update frequency in minutes
   */
  getUpdateFrequency(): number;

  /**
   * Set the update frequency in minutes
   * @param minutes Update frequency in minutes
   */
  setUpdateFrequency(minutes: number): Promise<void>;

  /**
   * Set the tracking repository path and log file
   * @param repoPath Path to the tracking repository
   * @param logFile Name of the log file
   */
  setTrackerRepo(
    repoPath: string,
    logFile: string
  ): Promise<Result<void, Error>>;

  /**
   * Set excluded branches
   * @param branches Array of branch names to exclude
   */
  setExcludedBranches(branches: string[]): Promise<void>;

  /**
   * Reset all configuration to default values
   * @returns Promise that resolves when reset is complete
   */
  resetToDefaults(): Promise<void>;

  /**
   * Get all configuration settings
   * @returns Object containing all configuration values
   */
  getAllSettings(): Record<string, any>;
}
