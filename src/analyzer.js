/**
 * Ekstrak item baru dari teks hasil scrape e-learning.
 * Filter ketat: abaikan UI noise, forum default, kalender kosong.
 */

function normalizeTask(item) {
  if (!item || typeof item !== 'object') return null;
  const matkul = String(item.matkul || '').trim();
  const judul = String(item.judul_tugas || item.judul || '').trim();
  const deadline = String(item.deadline || '').trim();
  const deskripsi = String(item.deskripsi || '').trim();
  const section = String(item.section || '').trim();
  const tipe = String(item.tipe || 'aktivitas').trim();
  if (!matkul && !judul) return null;

  let id = String(item.id || '').trim();
  if (!id) {
    id = [matkul, tipe, judul, deadline].filter(Boolean).join('_');
  }
  id = id
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-]/g, '')
    .slice(0, 200);

  return {
    id,
    matkul,
    judul_tugas: judul,
    deadline,
    deskripsi,
    section,
    tipe,
  };
}

function parseItemLine(line) {
  const trimmed = line.replace(/^[-•*]?\s*/, '');

  if (/^ITEM_JSON:/i.test(trimmed)) {
    try {
      const obj = JSON.parse(trimmed.replace(/^ITEM_JSON:/i, ''));
      return {
        type: obj.type,
        id: obj.id,
        section: obj.section,
        title: obj.title,
        url: obj.href || obj.url,
        desc: obj.desc || obj.description || '',
      };
    } catch {
      return null;
    }
  }

  if (!/^ITEM\|/i.test(trimmed)) return null;
  const parts = trimmed.split('|');
  const data = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    data[p.slice(0, idx).trim().toLowerCase()] = p.slice(idx + 1).trim();
  }
  if (!data.title) return null;
  return data;
}

function typeLabel(type) {
  const map = {
    tugas: 'Tugas',
    kuis: 'Kuis',
    file: 'File/Materi',
    forum: 'Pengumuman',
    link: 'Link',
    halaman: 'Halaman',
    label: 'Info',
  };
  return map[type] || 'Aktivitas';
}

function isNoiseItem(type, title, url, desc) {
  const t = String(title || '').trim();
  const lower = t.toLowerCase();
  const d = String(desc || '').trim();

  // Label tanpa deskripsi diabaikan; label berdeskripsi = info pengumuman
  if (type === 'label' && d.length < 20) return true;
  if (type === 'aktivitas' && d.length < 20) return true;
  if (type === 'kalender') return true;

  if (type === 'forum') {
    if (/^(announcements|pengumuman|news forum|forum berita)$/i.test(t)) return true;
  }

  if (
    /^(upcoming events|new event|events key|skip events key|hide .+ events|there are no upcoming events|supplementary blocks|excellent & beneficial|jump to|new section|general)$/i.test(
      t
    )
  ) {
    return true;
  }

  if ((type === 'file' || type === 'link' || type === 'halaman') && !url) return true;
  if (lower === 'pengumuman' || lower === 'announcements') return true;

  return false;
}

function extractAssignments(scrapedText) {
  const tasks = [];
  const text = String(scrapedText);

  const blocks = text.split(/===\s*(?:COURSE|SECTION):\s*/i);
  for (const block of blocks) {
    if (!block.trim()) continue;

    const headerMatch = block.match(/^([^\n=]+)/);
    let matkul = (headerMatch ? headerMatch[1] : 'Unknown').replace(/\s+/g, ' ').trim();
    if (/\s@\s/.test(matkul)) {
      matkul = matkul.split(/\s@\s/).pop().trim();
    }
    matkul = matkul.slice(0, 120);
    if (/^DASHBOARD|^CALENDAR/i.test(matkul)) continue;

    // Ambil baris ITEM (JSON bisa panjang satu baris)
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const item = parseItemLine(line);
      if (!item) continue;

      const type = (item.type || 'aktivitas').toLowerCase();
      const desc = String(item.desc || '').trim();
      if (isNoiseItem(type, item.title, item.url, desc)) continue;
      if (/^new section$/i.test(item.title)) continue;

      const allowed = ['tugas', 'kuis', 'file', 'forum', 'link', 'halaman', 'label'];
      if (!allowed.includes(type)) continue;

      const stableId = item.id
        ? `${matkul}_${type}_${item.id}`
        : `${matkul}_${type}_${item.title}`;

      tasks.push(
        normalizeTask({
          id: stableId,
          matkul,
          judul_tugas: String(item.title).slice(0, 160),
          deadline: '',
          tipe: type === 'label' ? 'label' : type,
          section: String(item.section || '').slice(0, 200),
          deskripsi: desc.slice(0, 500),
        })
      );
    }
  }

  const seen = new Set();
  return tasks.filter((t) => {
    if (!t || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

function analyzeAssignments(_env, scrapedText) {
  const tasks = extractAssignments(scrapedText);
  console.log(`[analyze] ${tasks.length} item relevan diekstrak (setelah filter noise).`);
  return tasks;
}

module.exports = {
  analyzeAssignments,
  extractAssignments,
  normalizeTask,
  isNoiseItem,
  typeLabel,
};
