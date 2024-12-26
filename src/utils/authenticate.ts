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

    const params = new URLSearchParams(deviceCodeResponse.data);
    const paramsObj = Object.fromEntries(params.entries());

    const {
      device_code,
      expires_in,
      interval,
      user_code,
      verification_uri
    } = paramsObj;

    const expiresInNumber = expires_in ? parseInt(expires_in, 10) : null;
    const intervalNumber = interval ? parseInt(interval, 10) : null;

    // Step 2: Prompt the user to authenticate
    if (verification_uri && user_code) {
      console.log('Device code:', device_code);
      console.log('user_code:', user_code);
      console.log('verification_uri:', verification_uri);
      vscode.window.showInformationMessage(
        `To authenticate with GitHub, please visit ${verification_uri} and enter the code: ${user_code}`
      );
    }

    if (device_code && intervalNumber && expiresInNumber) {
      // Step 3: Poll GitHub for access token
      const accessToken = await pollForAccessToken(device_code, intervalNumber, expiresInNumber);
      console.log('accessToken', accessToken)

      if (accessToken) {
        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: accessToken });

        // Store the token securely using SecretStorage API
        await context.secrets.store('githubAccessToken', accessToken);

        vscode.window.showInformationMessage('GitHub Authentication Successful!');
      } else {
        vscode.window.showErrorMessage('GitHub Authentication Failed or Timed Out.');
      }
    }
  } catch (error) {
    console.error('Authentication error:', error);
    vscode.window.showErrorMessage('An error occurred during GitHub authentication.');
  }
}