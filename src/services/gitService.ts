import { exec } from 'child_process';
import simpleGit, { SimpleGit } from 'simple-git';

export async function getCommitMessage(repoPath: string, commitId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git show -s --format=%B ${commitId}`, { cwd: repoPath }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function pushChanges(repoPath: string, logFilePath: string, branch: string): Promise<void> {
  const git: SimpleGit = simpleGit(repoPath);
  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some(remote => remote.name === 'origin');

  if (!hasOrigin) {
    throw new Error('No origin remote configured for the repository.');
  }

  await git.add(logFilePath);
  await git.commit('Update commit log');
  await git.push('origin', branch);
}