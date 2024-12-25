import * as vscode from 'vscode';
import axios from 'axios';
import * as qs from 'querystring';
import { pollForAccessToken } from './pollForAccessToken';

const CLIENT_ID = 'Ov23liHEllknMDBwy0BM';

// Function to initiate OAuth Device Flow
export async function authenticate(context: vscode.ExtensionContext) {
  try {
    // Step 1: Request device and user codes from GitHub
    const deviceCodeResponse = await axios.post(
      'https://github.com/login/device/code',
      qs.stringify({
        client_id: CLIENT_ID,
        scope: 'repo' // Adjust scopes as needed
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { device_code, user_code, verification_uri, expires_in, interval } = deviceCodeResponse.data;

    // console.log('Device code:', device_code);
    // console.log('user_code:', user_code);
    // console.log('verification_uri:', verification_uri);

    // Step 2: Prompt the user to authenticate
    vscode.window.showInformationMessage(
      `To authenticate with GitHub, please visit ${verification_uri} and enter the code: ${user_code}`
    );

    // Step 3: Poll GitHub for access token
    const accessToken = await pollForAccessToken(device_code, interval, expires_in);

    if (accessToken) {
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: accessToken });

      // Store the token securely using SecretStorage API
      await context.secrets.store('githubAccessToken', accessToken);

      vscode.window.showInformationMessage('GitHub Authentication Successful!');
    } else {
      vscode.window.showErrorMessage('GitHub Authentication Failed or Timed Out.');
    }
  } catch (error) {
    console.error('Authentication error:', error);
    vscode.window.showErrorMessage('An error occurred during GitHub authentication.');
  }
}