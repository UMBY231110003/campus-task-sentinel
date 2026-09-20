/**
 * Memori deduplikasi via Google Sheets.
 * Kolom A = id tugas yang sudah pernah dikirim.
 */
const { google } = require('googleapis');
const { createAuthClient, SCOPES_SHEETS } = require('./googleAuth');

async function getSheetsClient(env) {
  const auth = await createAuthClient({
    credentialsPath: env.GOOGLE_CREDENTIALS_PATH,
    tokenPath: env.GMAIL_TOKEN_PATH, // reuse OAuth token jika bukan service account
    scopes: SCOPES_SHEETS,
  });
  return google.sheets({ version: 'v4', auth });
}

function tabRange(tab, range) {
  const safe = /[^A-Za-z0-9_]/.test(tab) ? `'${tab.replace(/'/g, "''")}'` : tab;
  return `${safe}!${range}`;
}

/**
 * Baca semua ID yang sudah tersimpan di kolom A.
 */
async function getKnownTaskIds(env) {
  const sheets = await getSheetsClient(env);
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const tab = env.GOOGLE_SHEET_TAB || 'Sheet1';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabRange(tab, 'A:A'),
  });

  const rows = res.data.values || [];
  const ids = new Set(
    rows
      .flat()
      .map((v) => String(v || '').trim())
      .filter((v) => v && v.toLowerCase() !== 'id')
  );

  console.log(`[sheets] Histori: ${ids.size} ID tugas tersimpan.`);
  return ids;
}

/**
 * Filter hanya tugas yang belum pernah dikirim.
 */
function filterNewTasks(tasks, knownIds) {
  return tasks.filter((t) => t.id && !knownIds.has(t.id));
}

/**
 * Append ID tugas baru (+ metadata) ke sheet.
 * Kolom: A=id, B=matkul, C=judul, D=deadline, E=timestamp
 */
async function appendTaskIds(env, tasks) {
  if (!tasks.length) return;

  const sheets = await getSheetsClient(env);
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const tab = env.GOOGLE_SHEET_TAB || 'Sheet1';
  const now = new Date().toISOString();

  const values = tasks.map((t) => [
    t.id,
    t.matkul,
    t.judul_tugas,
    t.deadline,
    now,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: tabRange(tab, 'A:E'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  console.log(`[sheets] ${tasks.length} ID baru ditambahkan ke Google Sheets.`);
}

module.exports = { getKnownTaskIds, filterNewTasks, appendTaskIds };
