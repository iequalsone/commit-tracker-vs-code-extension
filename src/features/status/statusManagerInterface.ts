/**
 * Interface defining the public API for StatusManager
 * that RepositoryManager can rely on
 */
export interface IStatusManager {
  /**
   * Update the status bar to indicate tracking started
   */
  setTrackingStatus(): void;

  /**
   * Update the status bar to indicate tracking stopped
   */
  setStoppedStatus(): void;

  /**
   * Update the status bar to show an error state
   * @param reason Optional text indicating the reason for the error
   */
  setErrorStatus(reason?: string): void;

  /**
   * Update the status bar to show a processing state
   * @param message Optional message to show during processing
   */
  setProcessingStatus(message?: string): void;

  /**
   * Update the status bar to indicate unpushed commits
   * @param hasUnpushed Whether there are unpushed commits
   */
  updateUnpushedIndicator(hasUnpushed: boolean): void;

  /**
   * Show status for a commit detection event
   * @param repoName The name of the repository
   */
  showCommitDetectedStatus(repoName: string): void;

  /**
   * Show status for a commit being processed
   * @param repoName The name of the repository
   * @param hash The commit hash (shortened)
   */
  showCommitProcessingStatus(repoName: string, hash: string): void;

  /**
   * Show success status for a processed commit
   * @param repoName The name of the repository
   * @param hash The commit hash (shortened)
   */
  showCommitProcessedStatus(repoName: string, hash: string): void;

  /**
   * Show failure status for a failed commit process
   * @param error Error message or object
   */
  showCommitFailedStatus(error: Error | string): void;
}
