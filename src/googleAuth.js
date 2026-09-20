/**
 * Autentikasi Google (Gmail OAuth2 + Sheets Service Account / OAuth2)
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES_GMAIL = ['https://www.googleapis.com/auth/gmail.readonly'];
const SCOPES_SHEETS = ['https://www.googleapis.com/auth/spreadsheets'];

function loadCredentials(credentialsPath) {
  const resolved = path.resolve(credentialsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `File credentials tidak ditemukan: ${resolved}\n` +
        'Ikuti panduan di README.md untuk membuat Google Cloud credentials.'
    );
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

/**
 * Buat auth client. Mendukung:
 * - Service Account (type: service_account) — ideal untuk Sheets
 * - OAuth2 Desktop/Web + token tersimpan — diperlukan untuk Gmail user mailbox
 */
async function createAuthClient({ credentialsPath, tokenPath, scopes }) {
  const credentials = loadCredentials(credentialsPath);

  if (credentials.type === 'service_account') {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes,
    });
    return auth.getClient();
  }

  // OAuth2 (installed / web)
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    (redirect_uris && redirect_uris[0]) || 'http://localhost'
  );

  const resolvedToken = path.resolve(tokenPath);
  if (!fs.existsSync(resolvedToken)) {
    throw new Error(
      `Token OAuth2 tidak ditemukan: ${resolvedToken}\n` +
        'Jalankan: node scripts/authorize-gmail.js untuk menghasilkan token.'
    );
  }

  const token = JSON.parse(fs.readFileSync(resolvedToken, 'utf8'));
  oAuth2Client.setCredentials(token);

  oAuth2Client.on('tokens', (tokens) => {
    const merged = { ...token, ...tokens };
    fs.writeFileSync(resolvedToken, JSON.stringify(merged, null, 2));
  });

  return oAuth2Client;
}

module.exports = {
  createAuthClient,
  loadCredentials,
  SCOPES_GMAIL,
  SCOPES_SHEETS,
};
