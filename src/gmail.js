/**
 * Ambil magic link / OTP dari email Gmail terbaru (SSO UMBY).
 */
const { google } = require('googleapis');
const { createAuthClient, SCOPES_GMAIL } = require('./googleAuth');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOtp(text) {
  if (!text) return null;
  const labeled =
    text.match(
      /(?:kode|otp|verification|verifikasi|one[-\s]?time|security\s*code)[^\d]{0,40}(\d{4,8})/i
    ) ||
    text.match(/(\d{4,8})[^\d]{0,40}(?:kode|otp|verification|verifikasi)/i);
  if (labeled) return labeled[1];

  const plain = text.match(/\b(\d{6})\b/);
  return plain ? plain[1] : null;
}

/**
 * Ekstrak URL magic link SSO dari isi email.
 * Contoh: https://sso.mercubuana-yogya.ac.id/magiclink/...
 */
function extractMagicLink(text, baseHost = 'sso.mercubuana-yogya.ac.id') {
  if (!text) return null;

  const cleaned = text.replace(/&amp;/g, '&').replace(/=\r?\n/g, '');

  const hostRe = baseHost.replace(/\./g, '\\.');
  const patterns = [
    new RegExp(`https?:\\/\\/${hostRe}\\/magiclink\\/[^\\s"'<>\\]\\)]+`, 'i'),
    /https?:\/\/[^\s"'<>]*\/magiclink\/[^\s"'<>]+/i,
  ];

  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m) {
      return m[0].replace(/&amp;/g, '&').replace(/[>),.;"']+$/g, '');
    }
  }

  const href = cleaned.match(/href=["'](https?:\/\/[^"']*magiclink[^"']*)["']/i);
  if (href) return href[1].replace(/&amp;/g, '&');

  return null;
}

function decodeBody(payload) {
  const parts = [];

  function walk(part) {
    if (!part) return;
    if (part.body && part.body.data) {
      parts.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return parts.join('\n');
}

function buildQueries({ from, subject, afterMs }) {
  const queries = [];
  const fromDefault = from || 'noreply@umby.ac.id';

  // Query longgar & akurat untuk SSO UMBY (hindari after: epoch yang sering meleset)
  queries.push(`from:${fromDefault} newer_than:1h`);
  queries.push(`subject:"Two Step Verification" newer_than:1h`);
  queries.push(`("Two Step Verification" OR magiclink OR "melanjutkan login") newer_than:1h`);
  if (subject) queries.push(`subject:(${subject}) newer_than:2h`);
  queries.push('newer_than:30m in:inbox');
  queries.push('newer_than:1h in:anywhere');

  if (afterMs) {
    const after = `after:${Math.floor((afterMs - 120000) / 1000)}`; // toleransi 2 menit
    queries.push(`from:${fromDefault} ${after}`);
  }

  return [...new Set(queries)];
}

/**
 * Poll Gmail: prioritaskan magic link, fallback OTP numerik.
 * @returns {{ type: 'magiclink'|'otp', value: string, from?: string, subject?: string }}
 */
async function fetchLoginChallenge({
  credentialsPath,
  tokenPath,
  from,
  subject,
  afterMs,
  waitMs = 120000,
  pollIntervalMs = 4000,
  portalHost = 'sso.mercubuana-yogya.ac.id',
}) {
  const auth = await createAuthClient({
    credentialsPath,
    tokenPath,
    scopes: SCOPES_GMAIL,
  });
  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log(`[gmail] Akun terhubung: ${profile.data.emailAddress}`);
  } catch {
    console.warn('[gmail] Tidak bisa membaca profil akun.');
  }

  const queries = buildQueries({ from, subject, afterMs });
  const deadline = Date.now() + waitMs;
  console.log(`[gmail] Mencari magic link / OTP...\n  - ${queries.join('\n  - ')}`);

  while (Date.now() < deadline) {
    for (const q of queries) {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q,
        maxResults: 10,
      });

      const messages = list.data.messages || [];
      for (const msg of messages) {
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const internalDate = Number(full.data.internalDate || 0);
        // Toleransi clock skew 2 menit
        if (afterMs && internalDate + 120000 < afterMs) continue;

        const headers = full.data.payload?.headers || [];
        const subjectHdr =
          headers.find((h) => h.name.toLowerCase() === 'subject')?.value || '';
        const fromHdr =
          headers.find((h) => h.name.toLowerCase() === 'from')?.value || '';

        const body = decodeBody(full.data.payload);
        const snippet = full.data.snippet || '';
        const blob = `${subjectHdr}\n${snippet}\n${body}`;

        const magic = extractMagicLink(blob, portalHost);
        if (magic) {
          console.log(`[gmail] Magic link ditemukan.`);
          console.log(`[gmail] Dari: ${fromHdr} | Subjek: ${subjectHdr}`);
          try {
            await gmail.users.messages.modify({
              userId: 'me',
              id: msg.id,
              requestBody: { removeLabelIds: ['UNREAD'] },
            });
          } catch {
            /* ignore */
          }
          return { type: 'magiclink', value: magic, from: fromHdr, subject: subjectHdr };
        }

        const otp = extractOtp(blob);
        if (otp) {
          console.log(`[gmail] OTP numerik ditemukan: ${otp}`);
          try {
            await gmail.users.messages.modify({
              userId: 'me',
              id: msg.id,
              requestBody: { removeLabelIds: ['UNREAD'] },
            });
          } catch {
            /* ignore */
          }
          return { type: 'otp', value: otp, from: fromHdr, subject: subjectHdr };
        }
      }
    }

    console.log('[gmail] Belum ada magic link/OTP, menunggu...');
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timeout: magic link/OTP tidak ditemukan dalam ${waitMs}ms. Pastikan OAuth memakai Gmail mahasiswa.`
  );
}

/** @deprecated gunakan fetchLoginChallenge */
async function fetchLatestOtp(opts) {
  const result = await fetchLoginChallenge(opts);
  if (result.type === 'otp') return result.value;
  throw new Error('Email berisi magic link, bukan OTP numerik. Gunakan fetchLoginChallenge.');
}

module.exports = {
  fetchLoginChallenge,
  fetchLatestOtp,
  extractOtp,
  extractMagicLink,
};
