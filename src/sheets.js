/**
 * Memori deduplikasi via Google Sheets.
 * Kolom A = id tugas yang sudah pernah dikirim.
 * Kolom B+C = matkul+judul sebagai fingerprint cadangan (ID lama/baru).
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

function fingerprintOf(matkul, judul) {
  return `${String(matkul || '')
    .trim()
    .toLowerCase()}|${String(judul || '')
    .trim()
    .toLowerCase()}`;
}

/**
 * Baca histori: ID (kolom A) + fingerprint matkul|judul (B+C).
 */
async function getKnownTaskIds(env) {
  const sheets = await getSheetsClient(env);
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const tab = env.GOOGLE_SHEET_TAB || 'Sheet1';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabRange(tab, 'A:C'),
  });

  const rows = res.data.values || [];
  const ids = new Set();
  const fingerprints = new Set();

  for (const row of rows) {
    const id = String(row?.[0] || '').trim();
    if (id && id.toLowerCase() !== 'id') ids.add(id);

    const matkul = String(row?.[1] || '').trim();
    const judul = String(row?.[2] || '').trim();
    if (matkul || judul) {
      const fp = fingerprintOf(matkul, judul);
      if (fp !== '|') fingerprints.add(fp);
    }
  }

  console.log(
    `[sheets] Histori: ${ids.size} ID, ${fingerprints.size} fingerprint tersimpan.`
  );
  return { ids, fingerprints };
}

/**
 * Filter hanya tugas yang belum pernah dikirim (by id atau fingerprint).
 */
function filterNewTasks(tasks, known) {
  const knownIds = known?.ids instanceof Set ? known.ids : known;
  const knownFp =
    known?.fingerprints instanceof Set ? known.fingerprints : new Set();

  return tasks.filter((t) => {
    if (!t?.id) return false;
    if (knownIds.has(t.id)) return false;
    const fp = fingerprintOf(t.matkul, t.judul_tugas);
    if (fp !== '|' && knownFp.has(fp)) return false;
    return true;
  });
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

module.exports = { getKnownTaskIds, filterNewTasks, appendTaskIds, fingerprintOf };
