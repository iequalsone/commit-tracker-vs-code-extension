import { getCommitMessage, pushChanges } from '../../src/services/gitService';
import * as vscode from 'vscode';
import * as child_process from 'child_process';

jest.mock('child_process');
jest.mock('vscode');

describe('gitService', () => {
  describe('getCommitMessage', () => {
    it('should fetch commit message successfully', async () => {
      const mockExec = jest.spyOn(child_process, 'exec');
      mockExec.mockImplementation((cmd, opts, callback) => {
        if (callback) {
          callback(null, 'Test commit message', '');
        }
        return {} as child_process.ChildProcess;
      });

      const message = await getCommitMessage('/test/repo', 'abc123');
      expect(message).toBe('Test commit message');
    });

    it('should handle git command errors', async () => {
      const mockExec = jest.spyOn(child_process, 'exec');
      mockExec.mockImplementation((cmd, opts, callback) => {
        if (callback) {
          callback(new Error('Git error'), '', '');
        }
        return {} as child_process.ChildProcess;
      });

      await expect(getCommitMessage('/test/repo', 'abc123'))
        .rejects
        .toThrow('Git error');
    });
  });
});