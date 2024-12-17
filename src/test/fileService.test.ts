import { appendToFile, ensureDirectoryExists, validatePath } from '../../src/services/fileService';
import * as fs from 'fs';

jest.mock('fs');

describe('fileService', () => {
  describe('appendToFile', () => {
    it('should append content to file', async () => {
      const mockAppendFile = jest.spyOn(fs.promises, 'appendFile');
      mockAppendFile.mockResolvedValue();

      await appendToFile('/test/file.log', 'test content');
      expect(mockAppendFile).toHaveBeenCalledWith('/test/file.log', 'test content');
    });
  });

  describe('validatePath', () => {
    it('should validate absolute paths', () => {
      expect(validatePath('/absolute/path')).toBe(true);
      expect(validatePath('../relative/path')).toBe(false);
    });
  });
});