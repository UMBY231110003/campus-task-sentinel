/**
 * Kirim notifikasi ke Telegram — satu pesan per mata kuliah.
 * Di dalam pesan: group per section. Tanpa URL / penomoran.
 */
const axios = require('axios');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function typeIcon(tipe) {
  return (
    {
      tugas: '📝',
      kuis: '❓',
      file: '📄',
      forum: '📢',
      link: '🔗',
      halaman: '📃',
      label: 'ℹ️',
    }[tipe] || '•'
  );
}

/** Satu pesan HTML untuk satu mata kuliah */
function formatMatkulMessage(matkul, items) {
  const bySection = new Map();
  for (const t of items) {
    const section = t.section || 'Umum';
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(t);
  }

  const lines = [`📚 <b>${escapeHtml(matkul)}</b>`];

  for (const [section, sectionItems] of bySection) {
    lines.push('');
    lines.push(`📂 <b>${escapeHtml(section)}</b>`);
    for (const t of sectionItems) {
      const rawTitle = String(t.judul_tugas || '').trim();
      const rawDesc = String(t.deskripsi || '').trim();
      const titleSameAsSection =
        rawTitle.localeCompare(section, undefined, { sensitivity: 'accent' }) === 0;

      // Judul sama dengan section → jangan ulang; tampilkan deskripsi saja
      if (titleSameAsSection) {
        if (rawDesc) {
          lines.push(escapeHtml(rawDesc));
        }
        continue;
      }

      const title = escapeHtml(rawTitle);
      const hasOpenDue = Boolean(t.opened || t.due);
      const deadline =
        !hasOpenDue && t.deadline ? ` · ${escapeHtml(t.deadline)}` : '';

      if (t.tipe === 'forum') {
        lines.push(title + deadline);
      } else {
        lines.push(`${typeIcon(t.tipe)} ${title}${deadline}`);
      }

      if (t.opened) {
        lines.push(`🔓 Opened: ${escapeHtml(t.opened)}`);
      }
      if (t.due) {
        lines.push(`🔒 Due: ${escapeHtml(t.due)}`);
      }

      if (rawDesc && rawDesc.localeCompare(rawTitle, undefined, { sensitivity: 'accent' }) !== 0) {
        // Jangan ulang baris Opened/Due yang sudah ditampilkan terstruktur
        const descClean = rawDesc
          .replace(/^\s*Opened\s*:[^\n]*/im, '')
          .replace(/^\s*Due(?:\s*date)?\s*:[^\n]*/im, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (descClean) {
          lines.push(`<i>${escapeHtml(descClean)}</i>`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Kembalikan array pesan — satu elemen per mata kuliah.
 */
function formatTasksMessages(tasks) {
  const byMatkul = new Map();
  for (const t of tasks) {
    const matkul = t.matkul || 'Lainnya';
    if (!byMatkul.has(matkul)) byMatkul.set(matkul, []);
    byMatkul.get(matkul).push(t);
  }

  return [...byMatkul.entries()].map(([matkul, items]) =>
    formatMatkulMessage(matkul, items)
  );
}

/** @deprecated gunakan formatTasksMessages */
function formatTasksMessage(tasks) {
  return formatTasksMessages(tasks).join('\n\n——————\n\n');
}

async function sendTelegramMessage(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum di-set.');
  }

  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!res.data?.ok) {
      throw new Error(`Telegram API error: ${JSON.stringify(res.data)}`);
    }
  }
}

/** Kirim satu pesan Telegram per mata kuliah */
async function sendTelegramUpdates(env, tasks) {
  const messages = formatTasksMessages(tasks);
  for (const message of messages) {
    await sendTelegramMessage(env, message);
    // jeda singkat agar tidak kena flood limit
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(
    `[telegram] ${messages.length} pesan terkirim ke chat ${env.TELEGRAM_CHAT_ID}.`
  );
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = {
  sendTelegramMessage,
  sendTelegramUpdates,
  formatTasksMessage,
  formatTasksMessages,
};
