import * as vscode from "vscode";
import { execSync } from "child_process";

/**
 * Service that handles all Git operations
 */
export class GitService {
  /**
   * Gets the current branch name
   * @param workspaceRoot Optional workspace root path
   * @returns The current branch name or null if not in a git repository
   */
  public async getCurrentBranch(
    workspaceRoot?: string
  ): Promise<string | null> {
    try {
      const path = workspaceRoot || this.getWorkspaceRoot();
      if (!path) {
        return null;
      }

      const branchName = execSync("git symbolic-ref --short HEAD", {
        cwd: path,
      })
        .toString()
        .trim();
      return branchName;
    } catch (error) {
      // Not in a git repository or git command failed
      return null;
    }
  }

  /**
   * Checks if there are any unpushed commits
   * @param workspaceRoot Optional workspace root path
   * @returns True if there are unpushed commits
   */
  public async hasUnpushedCommits(workspaceRoot?: string): Promise<boolean> {
    try {
      const path = workspaceRoot || this.getWorkspaceRoot();
      if (!path) {
        return false;
      }

      // Get current branch
      const branch = await this.getCurrentBranch(path);
      if (!branch) {
        return false;
      }

      // Check for unpushed commits
      const result = execSync(`git cherry -v origin/${branch}`, {
        cwd: path,
      }).toString();
      return result.trim().length > 0;
    } catch (error) {
      // This can fail if the branch doesn't exist on remote or other git issues
      // In case of an error, we assume there are unpushed commits
      return true;
    }
  }

  /**
   * Gets the path of the current workspace root
   * @returns The workspace path or null if no workspace is open
   */
  private getWorkspaceRoot(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return workspaceFolders[0].uri.fsPath;
  }
}
