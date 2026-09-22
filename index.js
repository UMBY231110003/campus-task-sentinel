/**
 * Campus Task Sentinel
 * Flow: Portal login (+ Gmail magic link) → E-learning scrape → Parse tugas → Sheets dedupe → Telegram
 */
require('dotenv').config();

const { loginPortal, scrapeElearning } = require('./src/portal');
const { analyzeAssignments } = require('./src/analyzer');
const {
  getKnownTaskIds,
  filterNewTasks,
  appendTaskIds,
} = require('./src/sheets');
const { sendTelegramUpdates } = require('./src/telegram');

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function main() {
  console.log('=== Campus Task Sentinel ===');
  console.log(`Time: ${new Date().toISOString()}`);

  requireEnv([
    'PORTAL_URL',
    'PORTAL_USERNAME',
    'PORTAL_PASSWORD',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'GOOGLE_SHEET_ID',
    'GOOGLE_CREDENTIALS_PATH',
  ]);

  const env = process.env;
  let browser;

  try {
    const session = await loginPortal(env);
    browser = session.browser;
    const { page } = session;

    const scraped = await scrapeElearning(page, env, session.context);
    const rawContent = `URL: ${scraped.url}\nJudul: ${scraped.title}\n\n${scraped.text}`;

    await browser.close();
    browser = null;

    const tasks = analyzeAssignments(env, rawContent);
    if (!tasks.length) {
      console.log('[main] No assignments extracted. Done.');
      return;
    }

    const knownIds = await getKnownTaskIds(env);
    const newTasks = filterNewTasks(tasks, knownIds);

    if (!newTasks.length) {
      console.log('[main] No new assignments. Skipping Telegram.');
      return;
    }

    console.log(`[main] ${newTasks.length} new assignment(s) found.`);

    // Simpan ID dulu agar run berikutnya tidak spam jika Telegram/network gagal di tengah.
    // Lebih baik miss 1 notifikasi daripada pesan berulang.
    await appendTaskIds(env, newTasks);
    await sendTelegramUpdates(env, newTasks);

    console.log('[main] Completed successfully.');
  } catch (err) {
    console.error('[main] FAILED:', err.message || err);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main();
