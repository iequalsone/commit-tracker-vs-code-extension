import * as vscode from "vscode";
import axios from "axios";
import { logError, logInfo } from "../utils/logger";

const GITHUB_AUTH_PROVIDER_ID = "github";
const SCOPES = ["repo"];

export interface GitHubUser {
  login: string;
  name: string;
  email: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

/**
 * Handles GitHub authentication and API interactions
 */
export class GitHubService {
  private session: vscode.AuthenticationSession | undefined;

  /**
   * Performs GitHub authentication or returns existing session
   */
  async authenticate(): Promise<vscode.AuthenticationSession> {
    try {
      logInfo("Authenticating with GitHub...");

      try {
        // Get existing session
        this.session = await vscode.authentication.getSession(
          GITHUB_AUTH_PROVIDER_ID,
          SCOPES,
          { createIfNone: false }
        );

        logInfo("Using existing GitHub authentication session");
        if (this.session) {
          return this.session;
        }
      } catch (error) {
        // No existing session found
      }

      // Create a new session
      logInfo("Creating new GitHub authentication session");
      this.session = await vscode.authentication.getSession(
        GITHUB_AUTH_PROVIDER_ID,
        SCOPES,
        { createIfNone: true }
      );

      logInfo("GitHub authentication successful");
      return this.session;
    } catch (error) {
      logError(`GitHub authentication failed: ${error}`);
      throw new Error(`Failed to authenticate with GitHub: ${error}`);
    }
  }

  /**
   * Gets the authenticated user's information
   */
  async getUser(): Promise<GitHubUser> {
    try {
      if (!this.session) {
        await this.authenticate();
      }

      const response = await axios.get("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${this.session!.accessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      logInfo(
        `Successfully retrieved GitHub user info for: ${response.data.login}`
      );
      return {
        login: response.data.login,
        name: response.data.name || response.data.login,
        email: response.data.email || "",
      };
    } catch (error) {
      logError(`Failed to get GitHub user: ${error}`);
      throw new Error(`Failed to get GitHub user information: ${error}`);
    }
  }

  /**
   * Gets the user's repositories
   */
  async getRepositories(): Promise<GitHubRepo[]> {
    try {
      if (!this.session) {
        await this.authenticate();
      }

      const response = await axios.get(
        "https://api.github.com/user/repos?per_page=100",
        {
          headers: {
            Authorization: `Bearer ${this.session!.accessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );

      logInfo(`Successfully retrieved ${response.data.length} repositories`);
      return response.data.map((repo: any) => ({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
        html_url: repo.html_url,
        clone_url: repo.clone_url,
        ssh_url: repo.ssh_url,
      }));
    } catch (error) {
      logError(`Failed to get GitHub repositories: ${error}`);
      throw new Error(`Failed to get GitHub repositories: ${error}`);
    }
  }

  /**
   * Creates a new repository for commit tracking
   */
  async createRepository(
    name: string,
    isPrivate: boolean = true
  ): Promise<GitHubRepo> {
    try {
      if (!this.session) {
        await this.authenticate();
      }

      const response = await axios.post(
        "https://api.github.com/user/repos",
        {
          name,
          private: isPrivate,
          description:
            "Commit tracker repository created by VS Code Commit Tracker extension",
          auto_init: true,
        },
        {
          headers: {
            Authorization: `Bearer ${this.session!.accessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );

      logInfo(`Successfully created repository: ${response.data.full_name}`);
      return {
        id: response.data.id,
        name: response.data.name,
        full_name: response.data.full_name,
        private: response.data.private,
        html_url: response.data.html_url,
        clone_url: response.data.clone_url,
        ssh_url: response.data.ssh_url,
      };
    } catch (error) {
      logError(`Failed to create GitHub repository: ${error}`);
      throw new Error(`Failed to create GitHub repository: ${error}`);
    }
  }
}
