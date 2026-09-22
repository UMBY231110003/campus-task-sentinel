/**
 * Memori deduplikasi via Google Sheets.
 * Kolom A = id, B = matkul, C = judul, D = deadline, E = timestamp.
 *
 * Catatan: JANGAN pakai values.append tanpa baris eksplisit — API bisa
 * "menebak" tabel di kolom E+ dan menulis ke sana (bug yang bikin spam).
 */
const { google } = require('googleapis');
const { createAuthClient, SCOPES_SHEETS } = require('./googleAuth');

async function getSheetsClient(env) {
  const auth = await createAuthClient({
    credentialsPath: env.GOOGLE_CREDENTIALS_PATH,
    tokenPath: env.GMAIL_TOKEN_PATH,
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

/** Judul saja — tahan kalau nama matkul digeser sedikit */
function titleFingerprint(judul) {
  return String(judul || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Baca histori dari A:C, plus E:G (bekas append yang salah kolom).
 */
async function getKnownTaskIds(env) {
  const sheets = await getSheetsClient(env);
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const tab = env.GOOGLE_SHEET_TAB || 'Sheet1';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabRange(tab, 'A:I'),
  });

  const rows = res.data.values || [];
  const ids = new Set();
  const fingerprints = new Set();

  const addId = (v) => {
    const id = String(v || '').trim();
    if (id && id.toLowerCase() !== 'id' && !id.startsWith('__dedupe_probe_')) {
      ids.add(id);
    }
  };
  const addFp = (matkul, judul) => {
    const fp = fingerprintOf(matkul, judul);
    if (fp !== '|') fingerprints.add(fp);
    const tf = titleFingerprint(judul);
    if (tf) fingerprints.add(`title:${tf}`);
  };

  for (const row of rows) {
    // Kolom A–C (lokasi benar)
    addId(row?.[0]);
    addFp(row?.[1], row?.[2]);

    // Kolom E–G = bekas values.append yang nyasar (id, matkul, judul)
    addId(row?.[4]);
    addFp(row?.[5], row?.[6]);
  }

  console.log(
    `[sheets] Histori: ${ids.size} ID, ${fingerprints.size} fingerprint tersimpan (rows=${rows.length}).`
  );
  return { ids, fingerprints, rowCount: rows.length };
}

/**
 * Filter hanya tugas yang belum pernah dikirim (by id / fingerprint / judul).
 */
function filterNewTasks(tasks, known) {
  const knownIds = known?.ids instanceof Set ? known.ids : known;
  const knownFp =
    known?.fingerprints instanceof Set ? known.fingerprints : new Set();

  return tasks.filter((t) => {
    if (!t?.id) return false;
    if (knownIds.has(t.id)) return false;

    // Moodle module id di akhir ID: Matkul_tipe_12345
    const modId = (String(t.id).match(/_(\d{5,})$/) || [])[1];
    if (modId && [...knownIds].some((k) => String(k).endsWith(`_${modId}`))) {
      return false;
    }

    const fp = fingerprintOf(t.matkul, t.judul_tugas);
    if (fp !== '|' && knownFp.has(fp)) return false;

    const tf = titleFingerprint(t.judul_tugas);
    if (tf && knownFp.has(`title:${tf}`)) return false;

    return true;
  });
}

/**
 * Tulis ID baru ke baris berikutnya di kolom A (update eksplisit, bukan append).
 */
async function appendTaskIds(env, tasks) {
  if (!tasks.length) return;

  const sheets = await getSheetsClient(env);
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const tab = env.GOOGLE_SHEET_TAB || 'Sheet1';
  const now = new Date().toISOString();

  // Hitung baris terpakai di kolom A saja
  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabRange(tab, 'A:A'),
  });
  const used = (colA.data.values || []).length;
  const startRow = used + 1;

  const values = tasks.map((t) => [
    t.id,
    t.matkul,
    t.judul_tugas,
    t.deadline || t.due || '',
    now,
  ]);
  const endRow = startRow + values.length - 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: tabRange(tab, `A${startRow}:E${endRow}`),
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  // Verifikasi singkat
  const verify = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabRange(tab, `A${startRow}:A${endRow}`),
  });
  const written = (verify.data.values || []).flat().filter(Boolean).length;
  if (written < tasks.length) {
    throw new Error(
      `[sheets] Gagal persist dedupe: diharapkan ${tasks.length} baris di A${startRow}, tertulis ${written}`
    );
  }

  console.log(
    `[sheets] ${tasks.length} ID ditulis ke ${tab}!A${startRow}:E${endRow} (verified).`
  );
}

module.exports = { getKnownTaskIds, filterNewTasks, appendTaskIds, fingerprintOf };
