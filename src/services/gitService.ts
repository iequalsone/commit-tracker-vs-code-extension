import { exec } from 'child_process';
import simpleGit, { SimpleGit } from 'simple-git';
import shellEscape from 'shell-escape';
import * as vscode from 'vscode';

export async function getCommitMessage(repoPath: string, commitId: string): Promise<string> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Fetching commit message...',
    cancellable: false
  }, async (progress, token) => {
    return new Promise((resolve, reject) => {
      const sanitizedRepoPath = shellEscape([repoPath]);
      const sanitizedCommitId = shellEscape([commitId]);
      exec(`git show -s --format=%B ${sanitizedCommitId}`, { cwd: sanitizedRepoPath }, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  });
}

export async function pushChanges(repoPath: string, trackingFilePath: string, branch: string): Promise<void> {
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Pushing changes...',
    cancellable: false
  }, async (ProgressLocation, token) => {
    const git: SimpleGit = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const hasOrigin = remotes.some(remote => remote.name === 'origin');

    if (!hasOrigin) {
      throw new Error('No origin remote configured for the repository.');
    }

    await git.add(trackingFilePath);
    await git.commit('Update commit log');
    await git.push('origin', branch);
  });
}