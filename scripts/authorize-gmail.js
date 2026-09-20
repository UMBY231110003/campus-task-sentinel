/**
 * One-time OAuth for Gmail + Sheets.
 * Usage: npm run authorize
 *
 * Opens browser, listens on http://localhost for redirect, saves token.
 * Login dengan: 231110003@student.mercubuana-yogya.ac.id
 */
require('dotenv').config();
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { google } = require('googleapis');
const { loadCredentials, SCOPES_GMAIL, SCOPES_SHEETS } = require('../src/googleAuth');

async function main() {
  const credentialsPath =
    process.env.GOOGLE_CREDENTIALS_PATH || './credentials/google-credentials.json';
  const tokenPath = process.env.GMAIL_TOKEN_PATH || './credentials/gmail-token.json';

  const credentials = loadCredentials(credentialsPath);
  if (credentials.type === 'service_account') {
    console.error(
      'Service Account tidak cocok untuk Gmail pribadi. Pakai OAuth Desktop client.'
    );
    process.exit(1);
  }

  const { client_secret, client_id } = credentials.installed || credentials.web;

  // Loopback server untuk redirect http://localhost
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address();
  const redirectUri = `http://localhost:${port}`;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  const scopes = [...new Set([...SCOPES_GMAIL, ...SCOPES_SHEETS])];
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });

  console.log('\n=== Campus Task Sentinel — Google Authorize ===');
  console.log('1. Login pakai akun Gmail mahasiswa (yang menerima OTP).');
  console.log('2. Izinkan akses Gmail (readonly) + Google Sheets.\n');
  console.log('Buka URL ini jika browser tidak terbuka otomatis:\n');
  console.log(authUrl);
  console.log('');

  // Coba buka browser
  const openCmd =
    process.platform === 'win32'
      ? `start "" "${authUrl}"`
      : process.platform === 'darwin'
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
  try {
    require('child_process').exec(openCmd);
  } catch {
    /* ignore */
  }

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timeout menunggu otorisasi (5 menit).'));
    }, 5 * 60 * 1000);

    server.on('request', async (req, res) => {
      try {
        const u = new URL(req.url, redirectUri);
        const err = u.searchParams.get('error');
        const authCode = u.searchParams.get('code');

        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>Gagal: ${err}</h1>`);
          clearTimeout(timer);
          server.close();
          reject(new Error(err));
          return;
        }

        if (!authCode) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Code tidak ditemukan</h1>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Otorisasi berhasil</h1><p>Anda boleh menutup tab ini dan kembali ke terminal.</p>'
        );
        clearTimeout(timer);
        server.close();
        resolve(authCode);
      } catch (e) {
        clearTimeout(timer);
        server.close();
        reject(e);
      }
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  const resolved = path.resolve(tokenPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(tokens, null, 2));
  console.log(`Token disimpan ke ${resolved}`);
  console.log('Selesai. Lanjut isi TELEGRAM_CHAT_ID lalu npm start.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
