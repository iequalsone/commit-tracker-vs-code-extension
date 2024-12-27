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

    if (!device_code || !user_code || !verification_uri) {
      throw new Error('Invalid response from GitHub');
    }

    const expiresInNumber = expires_in ? parseInt(expires_in, 10) : null;
    const intervalNumber = interval ? parseInt(interval, 10) : null;

    // Step 2: Prompt the user to authenticate
    const openUrl = 'Open GitHub';
    const copyCode = 'Copy Code';

    const openAction = await vscode.window.showInformationMessage(
      `To authenticate with GitHub, please visit the following URL: ${verification_uri}`,
      openUrl
    );

    if (openAction === openUrl) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(verification_uri));
      } catch (openError) {
        console.error('Failed to open the URL:', openError);
        vscode.window.showErrorMessage('Unable to open the verification URL. Please copy and paste it manually.');
      }
    }

    const copyAction = await vscode.window.showInformationMessage(
      `Enter the code provided: ${user_code}`,
      copyCode
    );

    if (copyAction === copyCode) {
      try {
        await vscode.env.clipboard.writeText(user_code);
        vscode.window.showInformationMessage('User code copied to clipboard.');
      } catch (clipboardError) {
        console.error('Failed to copy code:', clipboardError);
        vscode.window.showErrorMessage('Unable to copy the user code to clipboard. Please enter it manually.');
      }
    }

    // Step 3: Poll GitHub for access token
    const accessToken = await pollForAccessToken(device_code, intervalNumber!, expiresInNumber!);

    if (accessToken) {
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: accessToken });
      console.log('accessToken', accessToken);

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