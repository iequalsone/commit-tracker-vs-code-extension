import axios from 'axios';
import * as qs from 'querystring';

const CLIENT_ID = 'Ov23liHEllknMDBwy0BM';
const CLIENT_SECRET = '3879c1337585add2f255d8e61bba155370d72ab3';

export async function pollForAccessToken(device_code: string, interval: number, expires_in: number): Promise<string | null> {
  const pollInterval = interval * 1000; // Convert to milliseconds
  const maxAttempts = Math.floor(expires_in / interval);
  let attempts = 0;

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const tokenResponse = await axios.post(
          'https://github.com/login/oauth/access_token',
          qs.stringify({
            client_id: CLIENT_ID,
            device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_secret: CLIENT_SECRET
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            }
          }
        );

        if (tokenResponse.data.error) {
          if (tokenResponse.data.error === 'authorization_pending') {
            // Continue polling
            console.log('Authorization pending...');
          } else if (tokenResponse.data.error === 'slow_down') {
            // Increase interval by 5 seconds
            console.log('Slow down polling...');
            clearInterval(timer);
            setTimeout(() => {
              pollForAccessToken(device_code, interval, expires_in);
            }, 5000);
          } else {
            // Other errors
            console.error('Error during polling:', tokenResponse.data.error);
            clearInterval(timer);
            resolve(null);
          }
        } else {
          // Access token received
          console.log('Access token received:', tokenResponse.data.access_token);
          clearInterval(timer);
          resolve(tokenResponse.data.access_token);
        }
      } catch (error) {
        console.error('Polling error:', error);
        clearInterval(timer);
        resolve(null);
      }

      attempts += 1;
      if (attempts >= maxAttempts) {
        console.log('Polling timed out.');
        clearInterval(timer);
        resolve(null);
      }
    }, pollInterval);
  });
}