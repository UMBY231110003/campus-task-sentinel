/**
 * Ekstrak item baru dari teks hasil scrape e-learning.
 * Filter ketat: abaikan UI noise, forum default, kalender kosong.
 */

/** Ambil course-module id Moodle dari data-id atau query ?id= / ?cmid= */
function extractMoodleModId(urlOrId, dataId) {
  const raw = String(dataId || '').trim();
  if (/^\d+$/.test(raw)) return raw;
  const s = String(urlOrId || '');
  const m = s.match(/[?&](?:id|cmid)=(\d+)/i);
  return m ? m[1] : '';
}

function sanitizeIdPart(value) {
  return String(value || '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-]/g, '')
    .slice(0, 120);
}

/**
 * ID harus stabil antar scrape (course vs section, data-id ada/tidak).
 * Prioritas: Moodle module id → fallback matkul+tipe+judul.
 */
function buildStableTaskId(matkul, tipe, item) {
  const modId = extractMoodleModId(item.url || item.href || item.id, item.id);
  if (modId) {
    // Format kompatibel dengan ID lama: matkul_tipe_moduleId
    return sanitizeIdPart(`${matkul}_${tipe}_${modId}`).slice(0, 200);
  }
  const judul = String(item.judul_tugas || item.judul || item.title || '').trim();
  return sanitizeIdPart([matkul, tipe, judul].filter(Boolean).join('_')).slice(0, 200);
}

function normalizeTask(item) {
  if (!item || typeof item !== 'object') return null;
  const matkul = String(item.matkul || '').trim();
  const judul = String(item.judul_tugas || item.judul || '').trim();
  const deadline = String(item.deadline || '').trim();
  const deskripsi = String(item.deskripsi || '').trim();
  const section = String(item.section || '').trim();
  const tipe = String(item.tipe || 'aktivitas').trim();
  if (!matkul && !judul) return null;

  const id = buildStableTaskId(matkul, tipe, {
    id: item.id,
    url: item.url || item.href,
    href: item.href,
    judul_tugas: judul,
    title: judul,
  });

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

      tasks.push(
        normalizeTask({
          id: item.id,
          url: item.url || item.href,
          href: item.href || item.url,
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
    if (!t) return false;
    const fp = `${t.matkul}|${t.judul_tugas}|${t.tipe}`.toLowerCase();
    if (seen.has(t.id) || seen.has(fp)) return false;
    seen.add(t.id);
    seen.add(fp);
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
  extractMoodleModId,
  buildStableTaskId,
};
