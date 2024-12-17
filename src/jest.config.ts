export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverage: true,
  moduleFileExtensions: ['ts', 'js'],
  setupFiles: ['<rootDir>/test/setup.ts'],
}