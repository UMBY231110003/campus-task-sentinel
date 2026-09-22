/**
 * Login SSO kampus (UMBY) via Playwright + magic link / OTP dari Gmail.
 * Menyimpan sesi (cookies) agar run berikutnya tidak login ulang jika masih valid.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { fetchLoginChallenge } = require('./gmail');

const OTP_INPUT_CANDIDATES = [
  'input[name="otp"]',
  'input[name="code"]',
  'input[name="token"]',
  'input[name="verification_code"]',
  'input[name="one_time_password"]',
  'input[id*="otp" i]',
  'input[id*="kode" i]',
  'input[placeholder*="OTP" i]',
  'input[placeholder*="kode" i]',
  'input[placeholder*="verifikasi" i]',
  'input[autocomplete="one-time-code"]',
];

function authStatePath(env) {
  return path.resolve(env.AUTH_STATE_PATH || './credentials/auth-state.json');
}

async function isLoggedIn(page, env) {
  const url = page.url();
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 2000);

  const onLoginForm =
    (await page.locator('input[name="username"]').isVisible().catch(() => false)) &&
    (await page.locator('input[name="password"]').isVisible().catch(() => false));

  const waitingEmail =
    /\?user=/i.test(url) ||
    /melanjutkan login|Login Two Step|cek email|periksa email|check your email/i.test(body);

  if (onLoginForm || waitingEmail) return false;

  // Indikasi sudah masuk SSO / e-learning
  if (/\/home|elearning\.|\/my\/|dashboard/i.test(url)) return true;
  if (/E-Learning Portal|Course Overview|ALVIYAN|Mahasiswa/i.test(body)) return true;
  if (!onLoginForm && /sso\.mercubuana-yogya\.ac\.id/i.test(url) && !/\/login/i.test(url)) {
    return true;
  }
  return false;
}

async function saveAuthState(context, env) {
  const file = authStatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await context.storageState({ path: file });
  console.log(`[portal] Sesi disimpan ke ${file}`);
}

async function findOtpInput(page, preferredSelector, timeoutMs = 15000) {
  const selectors = preferredSelector
    ? [preferredSelector, ...OTP_INPUT_CANDIDATES]
    : OTP_INPUT_CANDIDATES;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;

    const stillLogin =
      (await page.locator('input[name="username"]').isVisible().catch(() => false)) &&
      (await page.locator('input[name="password"]').isVisible().catch(() => false));
    if (stillLogin) {
      await page.waitForTimeout(500).catch(() => {});
      continue;
    }

    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        const name = (await loc.getAttribute('name').catch(() => '')) || '';
        if (/username|password|email|search/i.test(name)) continue;
        return { locator: loc, selector: sel };
      }
    }

    const numeric = page.locator(
      'input[inputmode="numeric"]:not([name="username"]):not([name="password"]), input[type="tel"]:not([name="username"])'
    );
    const count = await numeric.count();
    if (count === 1 && (await numeric.first().isVisible().catch(() => false))) {
      return { locator: numeric.first(), selector: 'input[inputmode=numeric]|tel' };
    }

    await page.waitForTimeout(500);
  }
  return null;
}

async function launchBrowser(env) {
  const headless = String(env.PLAYWRIGHT_HEADLESS ?? 'true') !== 'false';
  const channel = env.PLAYWRIGHT_CHANNEL || '';
  const launchOpts = { headless };
  if (channel) launchOpts.channel = channel;
  return chromium.launch(launchOpts);
}

/**
 * Coba pakai sesi tersimpan. Return session jika valid, selain itu tutup browser & return null.
 */
async function tryReuseSession(env) {
  const file = authStatePath(env);
  if (!fs.existsSync(file)) {
    console.log('[portal] Belum ada sesi tersimpan — login penuh diperlukan.');
    return null;
  }

  console.log(`[portal] Mencoba sesi tersimpan: ${file}`);
  const browser = await launchBrowser(env);
  try {
    const context = await browser.newContext({
      locale: 'id-ID',
      viewport: { width: 1400, height: 900 },
      storageState: file,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(env.PLAYWRIGHT_TIMEOUT || 60000));

    // Cek SSO home dulu
    const homeUrl = (() => {
      try {
        return new URL('/home', env.PORTAL_URL).href;
      } catch {
        return `${env.PORTAL_URL.replace(/\/$/, '')}/home`;
      }
    })();

    await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    if (await isLoggedIn(page, env)) {
      console.log(`[portal] Sesi masih valid → ${page.url()}`);
      // Perpanjang / refresh file sesi
      await saveAuthState(context, env);
      return { browser, context, page };
    }

    console.log('[portal] Sesi kedaluwarsa / tidak valid. Login ulang...');
    await browser.close();
    return null;
  } catch (err) {
    console.warn(`[portal] Gagal memakai sesi tersimpan: ${err.message}`);
    await browser.close().catch(() => {});
    return null;
  }
}

async function performFullLogin(env) {
  const timeout = Number(env.PLAYWRIGHT_TIMEOUT || 60000);
  const browser = await launchBrowser(env);
  const context = await browser.newContext({
    locale: 'id-ID',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);

  console.log(`[portal] Membuka ${env.PORTAL_URL}`);
  await page.goto(env.PORTAL_URL, { waitUntil: 'domcontentloaded' });

  const userSel = env.PORTAL_SELECTOR_USERNAME || 'input[name="username"]';
  const passSel = env.PORTAL_SELECTOR_PASSWORD || 'input[name="password"]';
  const submitSel = env.PORTAL_SELECTOR_SUBMIT || '#login-btn';

  await page.waitForSelector(userSel);
  await page.fill(userSel, env.PORTAL_USERNAME);
  await page.fill(passSel, env.PORTAL_PASSWORD);

  const challengeStartedAt = Date.now() - 2000;
  await page.click(submitSel);
  console.log('[portal] Form login dikirim, menunggu verifikasi email / dashboard...');

  await Promise.race([
    page.waitForURL(/\?user=|magiclink|dashboard|home|verify|2fa/i, { timeout: 25000 }).catch(() => null),
    page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => null),
  ]);
  await page.waitForTimeout(1000);

  const pageText = (await page.locator('body').innerText().catch(() => '')) || '';
  const urlNow = page.url();
  const waitingForEmail =
    /\?user=/i.test(urlNow) ||
    /melanjutkan login|Login Two Step|cek email|periksa email|check your email|magic ?link|two[-\s]?step/i.test(
      pageText
    );

  const otpFound = waitingForEmail
    ? null
    : await findOtpInput(page, env.PORTAL_SELECTOR_OTP_INPUT, Number(env.OTP_DETECT_MS || 8000));

  const needsChallenge = waitingForEmail || Boolean(otpFound);

  if (needsChallenge) {
    console.log(
      waitingForEmail
        ? '[portal] Halaman menunggu verifikasi email (magic link) terdeteksi.'
        : `[portal] Form OTP terdeteksi (${otpFound.selector}).`
    );

    const challenge = await fetchLoginChallenge({
      credentialsPath: env.GOOGLE_CREDENTIALS_PATH,
      tokenPath: env.GMAIL_TOKEN_PATH,
      from: env.GMAIL_OTP_FROM,
      subject: env.GMAIL_OTP_SUBJECT,
      afterMs: challengeStartedAt,
      waitMs: Number(env.OTP_WAIT_MS || 180000),
      pollIntervalMs: Number(env.OTP_POLL_INTERVAL_MS || 4000),
      portalHost: (() => {
        try {
          return new URL(env.PORTAL_URL).host;
        } catch {
          return 'sso.mercubuana-yogya.ac.id';
        }
      })(),
    });

    if (challenge.type === 'magiclink') {
      console.log(`[portal] Membuka magic link dari email...`);
      console.log(`[portal] ${challenge.value.slice(0, 80)}...`);
      await page.goto(challenge.value, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
      console.log('[portal] Magic link dibuka.');
    } else {
      const input =
        otpFound ||
        (await findOtpInput(page, env.PORTAL_SELECTOR_OTP_INPUT, 10000));
      if (!input) {
        throw new Error('Email berisi OTP numerik tetapi form OTP tidak ditemukan di halaman.');
      }
      await input.locator.fill(challenge.value);
      const otpSubmitSel = env.PORTAL_SELECTOR_OTP_SUBMIT || '#login-btn, button[type="submit"]';
      const submitBtn = page.locator(otpSubmitSel).first();
      if ((await submitBtn.count()) > 0) await submitBtn.click();
      else await input.locator.press('Enter');
      await page.waitForLoadState('networkidle').catch(() => {});
      console.log('[portal] OTP dikirim.');
    }
  } else {
    console.log('[portal] Tidak ada challenge email — lanjut.');
  }

  await page.waitForTimeout(1500);
  console.log(`[portal] URL sekarang: ${page.url()}`);

  if (!(await isLoggedIn(page, env))) {
    throw new Error(
      'Login belum selesai setelah challenge email. Periksa magic link di Gmail mahasiswa.'
    );
  }

  await saveAuthState(context, env);
  return { browser, context, page };
}

async function loginPortal(env) {
  const reuse = String(env.AUTH_REUSE ?? 'true') !== 'false';

  if (reuse) {
    const session = await tryReuseSession(env);
    if (session) return session;
  }

  return performFullLogin(env);
}


/**
 * Ambil halaman kerja Playwright (handle redirect e-learning yang buka tab baru).
 */
async function gotoElearning(context, page, env) {
  const timeout = Number(env.PLAYWRIGHT_TIMEOUT || 60000);

  if (env.ELEARNING_URL) {
    console.log(`[scrape] Navigasi ke ${env.ELEARNING_URL}`);
    const popupPromise = context
      .waitForEvent('page', { timeout: 10000 })
      .catch(() => null);

    await page.goto(env.ELEARNING_URL, { waitUntil: 'domcontentloaded', timeout });
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      console.log(`[scrape] E-Learning terbuka di tab baru: ${popup.url()}`);
      return popup;
    }
    return page;
  }

  // Fallback: klik tombol "E-Learning Portal" di dashboard SSO
  const link = page.getByRole('link', { name: /e-learning\s*portal/i }).first();
  const btn = page.getByText(/e-learning\s*portal/i).first();
  const target = (await link.count()) > 0 ? link : btn;

  if ((await target.count()) > 0) {
    console.log('[scrape] Mengklik "E-Learning Portal"...');
    const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await target.click();
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      return popup;
    }
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  console.warn('[scrape] Menu E-Learning tidak ditemukan; scrape halaman saat ini.');
  return page;
}

/**
 * Scraping Moodle UMBY: Course Overview + Timeline (+ opsional tiap course).
 */
async function scrapeElearning(page, env, context) {
  const timeout = Number(env.PLAYWRIGHT_TIMEOUT || 60000);
  const workPage = await gotoElearning(context || page.context(), page, env);

  // Tunggu konten Moodle
  await Promise.race([
    workPage.waitForSelector('#block-region-content, .block_timeline, .course-info-container, #page-header, .dashboard-card', {
      timeout,
    }).catch(() => null),
    workPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
  ]);
  await workPage.waitForTimeout(2500);

  console.log(`[scrape] Halaman kerja: ${workPage.url()} | title: ${await workPage.title()}`);

  // Jika redirect kembali ke SSO login, gagal jelas
  if (/sso\.mercubuana-yogya\.ac\.id\/?$|\/login/i.test(workPage.url())) {
    const stillLogin = await workPage.locator('input[name="username"]').isVisible().catch(() => false);
    if (stillLogin) {
      throw new Error('E-Learning redirect gagal — sesi SSO belum valid (login/OTP belum sukses).');
    }
  }

  // Perluas filter Timeline ke rentang lebih panjang bila ada
  try {
    const filter = workPage.locator('.block_timeline select, [data-region="filter"] select').first();
    if ((await filter.count()) > 0) {
      const options = await filter.locator('option').allTextContents();
      const prefer =
        options.find((o) => /all|semua|30|60|90|month|bulan/i.test(o)) ||
        options.find((o) => /7|week|minggu/i.test(o));
      if (prefer) {
        await filter.selectOption({ label: prefer.trim() }).catch(async () => {
          await filter.selectOption({ index: options.length - 1 }).catch(() => {});
        });
        await workPage.waitForTimeout(1500);
      }
    }
  } catch {
    /* optional */
  }

  const contentSel =
    env.ELEARNING_SELECTOR ||
    '#region-main, .block_timeline, .block_myoverview, #block-region-content, body';

  const dashboard = await workPage.evaluate((selector) => {
    const roots = [];
    selector.split(',').forEach((s) => {
      document.querySelectorAll(s.trim()).forEach((el) => roots.push(el));
    });
    if (!roots.length) roots.push(document.body);

    const text = roots
      .map((el) => el.innerText || '')
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const courses = Array.from(
      document.querySelectorAll(
        [
          '.course-info-container a',
          '.coursename a',
          'a.aalink.coursename',
          '.dashboard-card a',
          '[data-region="course-content"] a',
          '.card-img-overlay a',
          'a[href*="/course/view.php"]',
        ].join(', ')
      )
    )
      .map((a) => ({
        title: (a.textContent || '').trim().replace(/\s+/g, ' '),
        href: a.href,
      }))
      .filter(
        (c) =>
          c.title &&
          c.href &&
          /\/course\/view\.php/i.test(c.href) &&
          !/star this course|star for|dashboard|calendar|preferences/i.test(c.title)
      );

    // dedupe by href
    const seen = new Set();
    const uniqueCourses = courses.filter((c) => {
      if (seen.has(c.href)) return false;
      seen.add(c.href);
      return true;
    });

    return {
      text,
      title: document.title,
      url: location.href,
      courses: uniqueCourses.slice(0, 20),
    };
  }, contentSel);

  let combinedText = `=== DASHBOARD E-LEARNING ===\nURL: ${dashboard.url}\nTitle: ${dashboard.title}\n\n${dashboard.text}`;

  // Kalender upcoming (sering berisi deadline tugas)
  try {
    const calUrl = new URL('/calendar/view.php?view=upcoming', workPage.url()).href;
    console.log(`[scrape] Membuka kalender: ${calUrl}`);
    await workPage.goto(calUrl, { waitUntil: 'domcontentloaded', timeout });
    await workPage.waitForTimeout(1200);
    const calText = await workPage.evaluate(() => {
      const main = document.querySelector('#region-main, .maincalendar, body');
      return (main?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
    });
    combinedText += `\n\n=== CALENDAR UPCOMING ===\n${calText}`;
  } catch (err) {
    console.warn(`[scrape] Kalender gagal: ${err.message}`);
  }

  // Kunjungi tiap course untuk ambil aktivitas (tugas/assignment)
  const maxCourses = Number(env.ELEARNING_MAX_COURSES || 12);
  const courses = dashboard.courses.slice(0, maxCourses);
  console.log(`[scrape] ${courses.length} course ditemukan, mengambil detail aktivitas...`);

  for (const course of courses) {
    try {
      console.log(`[scrape] → ${course.title}`);
      await workPage.goto(course.href, { waitUntil: 'domcontentloaded', timeout });
      await workPage.waitForTimeout(800);

      const courseData = await workPage.evaluate(() => {
        const main =
          document.querySelector('#region-main, #page-content, .course-content') ||
          document.body;

        function activityType(el) {
          const cls = el.className || '';
          const href = el.querySelector('a.aalink, a[href*="/mod/"]')?.href || '';
          if (/modtype_assign|\/mod\/assign\//i.test(`${cls} ${href}`)) return 'tugas';
          if (/modtype_quiz|\/mod\/quiz\//i.test(`${cls} ${href}`)) return 'kuis';
          if (/modtype_forum|\/mod\/forum\//i.test(`${cls} ${href}`)) return 'forum';
          if (/modtype_resource|\/mod\/resource\//i.test(`${cls} ${href}`)) return 'file';
          if (/modtype_url|\/mod\/url\//i.test(`${cls} ${href}`)) return 'link';
          if (/modtype_page|\/mod\/page\//i.test(`${cls} ${href}`)) return 'halaman';
          if (/modtype_label/i.test(cls)) return 'label';
          return 'aktivitas';
        }

        function readSectionName(el) {
          const sectionEl = el.closest('li.section, li.course-section');
          if (!sectionEl) return '';
          return (
            sectionEl.getAttribute('data-sectionname') ||
            sectionEl.querySelector('h3.sectionname a, h3.sectionname, .sectionname')
              ?.textContent ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();
        }

        function readDescription(el) {
          const node = el.querySelector(
            '.activity-altcontent, .activity-description, .activity-description-content, [data-region="activity-description"]'
          );
          if (!node) return '';
          return (node.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 600);
        }

        const items = [];
        const seen = new Set();

        document.querySelectorAll('li.activity[data-id], li.activity').forEach((el) => {
          const card = el.querySelector('[data-region="activity-card"], .activity-item') || el;
          const desc = readDescription(el);
          const name =
            card.getAttribute('data-activityname') ||
            el.querySelector('.instancename, .activityname a, a.aalink')?.textContent ||
            '';
          let title = name.replace(/\s+/g, ' ').replace(/\s*File\s*$/i, '').trim();
          // Label sering tidak punya judul link — pakai cuplikan deskripsi
          if (!title && desc) title = desc.slice(0, 80) + (desc.length > 80 ? '…' : '');
          if (!title || title.length < 2) return;

          const href = el.querySelector('a.aalink, a[href*="/mod/"]')?.href || '';
          const id =
            el.getAttribute('data-id') ||
            (href.match(/[?&](?:id|cmid)=(\d+)/i) || [])[1] ||
            '';
          const type = activityType(el);
          const section = readSectionName(el);

          const key = id || href || title;
          if (seen.has(key)) return;
          seen.add(key);
          if (/^new section$/i.test(title)) return;

          items.push({ id, type, title, href, section, desc });
        });

        const sections = Array.from(
          document.querySelectorAll(
            'h3.sectionname a[href*="/course/section.php"], a[href*="/course/section.php"], li.course-section[data-sectionname], option[value*="/course/section.php"]'
          )
        )
          .map((el) => {
            if (el.tagName === 'OPTION') {
              return {
                name: (el.textContent || '').trim(),
                href: el.value ? new URL(el.value, location.origin).href : '',
              };
            }
            if (el.tagName === 'A') {
              return {
                name: (el.textContent || '').replace(/\s+/g, ' ').trim(),
                href: el.href || '',
              };
            }
            return {
              name:
                el.getAttribute('data-sectionname') ||
                (el.textContent || '').trim(),
              href: el.querySelector?.('a')?.href || '',
            };
          })
          .filter((s) => s.name && !/^new section$|^jump to|^main course|^general$/i.test(s.name))
          .slice(0, 30);

        // dedupe sections by href/name
        const secSeen = new Set();
        const uniqueSections = sections.filter((s) => {
          const k = s.href || s.name;
          if (secSeen.has(k)) return false;
          secSeen.add(k);
          return true;
        });

        return {
          title: document.title,
          url: location.href,
          text: (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000),
          items,
          sections: uniqueSections,
        };
      });

      combinedText += `\n\n=== COURSE: ${course.title} ===\nURL: ${courseData.url}\n`;
      if (courseData.items.length) {
        combinedText += `Items:\n`;
        for (const it of courseData.items) {
          combinedText += `- ITEM_JSON:${JSON.stringify(it)}\n`;
        }
      }
      if (courseData.sections.length) {
        combinedText += `Sections:\n`;
        for (const s of courseData.sections.slice(0, 20)) {
          combinedText += `- SECTION|name=${s.name}|url=${s.href}\n`;
        }
      }
      combinedText += `\n${courseData.text.slice(0, 6000)}`;

      const sectionLinks = courseData.sections
        .filter((s) => s.href && /section\.php/i.test(s.href))
        .slice(0, Number(env.ELEARNING_MAX_SECTIONS || 8));

      for (const sec of sectionLinks) {
        try {
          console.log(`[scrape]   ↳ section: ${sec.name}`);
          await workPage.goto(sec.href, { waitUntil: 'domcontentloaded', timeout });
          await workPage.waitForTimeout(600);
          const secData = await workPage.evaluate((fallbackSection) => {
            function activityType(el) {
              const cls = el.className || '';
              const href = el.querySelector('a.aalink, a[href*="/mod/"]')?.href || '';
              if (/modtype_assign|\/mod\/assign\//i.test(`${cls} ${href}`)) return 'tugas';
              if (/modtype_quiz|\/mod\/quiz\//i.test(`${cls} ${href}`)) return 'kuis';
              if (/modtype_forum|\/mod\/forum\//i.test(`${cls} ${href}`)) return 'forum';
              if (/modtype_resource|\/mod\/resource\//i.test(`${cls} ${href}`)) return 'file';
              if (/modtype_url|\/mod\/url\//i.test(`${cls} ${href}`)) return 'link';
              if (/modtype_page|\/mod\/page\//i.test(`${cls} ${href}`)) return 'halaman';
              if (/modtype_label/i.test(cls)) return 'label';
              return 'aktivitas';
            }

            const sectionName =
              document
                .querySelector('li.course-section[data-sectionname]')
                ?.getAttribute('data-sectionname') ||
              document.querySelector('h3.sectionname a, h3.sectionname')?.textContent ||
              fallbackSection;

            const items = [];
            document.querySelectorAll('li.activity').forEach((el) => {
              const desc = (
                el.querySelector(
                  '.activity-altcontent, .activity-description, .activity-description-content'
                )?.innerText || ''
              )
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 600);

              let title = (
                el.querySelector('[data-activityname]')?.getAttribute('data-activityname') ||
                el.querySelector('.instancename, a.aalink')?.textContent ||
                ''
              )
                .replace(/\s+/g, ' ')
                .replace(/\s*File\s*$/i, '')
                .trim();
              if (!title && desc) title = desc.slice(0, 80) + (desc.length > 80 ? '…' : '');
              if (!title) return;

              const href = el.querySelector('a.aalink, a[href*="/mod/"]')?.href || '';
              const id =
                el.getAttribute('data-id') ||
                (href.match(/[?&](?:id|cmid)=(\d+)/i) || [])[1] ||
                '';
              items.push({
                id,
                type: activityType(el),
                title,
                href,
                section: (sectionName || '').replace(/\s+/g, ' ').trim(),
                desc,
              });
            });
            return items;
          }, sec.name);

          if (secData.length) {
            combinedText += `\n=== SECTION: ${sec.name} @ ${course.title} ===\nItems:\n`;
            for (const it of secData) {
              combinedText += `- ITEM_JSON:${JSON.stringify(it)}\n`;
            }
          }
        } catch (err) {
          console.warn(`[scrape]   section gagal: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[scrape] Gagal buka course ${course.title}: ${err.message}`);
    }
  }

  // Kunjungi halaman tugas (/mod/assign/view.php) untuk Opened/Due + .activity-description
  const assignHrefs = new Map();
  const assignUrlRe = /"href"\s*:\s*"(https?:[^"]*\/mod\/assign\/view\.php[^"]*)"/gi;
  let m;
  while ((m = assignUrlRe.exec(combinedText)) !== null) {
    try {
      const href = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      if (!assignHrefs.has(href)) assignHrefs.set(href, true);
    } catch {
      /* ignore */
    }
  }
  // Juga tangkap dari item yang sudah di-track via type tugas di JSON id
  const idHrefRe =
    /ITEM_JSON:(\{(?:[^{}]|"[^"]*")*"type"\s*:\s*"tugas"(?:[^{}]|"[^"]*")*\})/gi;
  while ((m = idHrefRe.exec(combinedText)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj.href && /\/mod\/assign\/view\.php/i.test(obj.href)) {
        assignHrefs.set(obj.href, true);
      }
    } catch {
      /* ignore */
    }
  }

  const maxAssigns = Number(env.ELEARNING_MAX_ASSIGNS || 25);
  const assignList = [...assignHrefs.keys()].slice(0, maxAssigns);
  if (assignList.length) {
    console.log(`[scrape] ${assignList.length} halaman tugas akan dibuka untuk tanggal buka/tutup...`);
  }

  for (const href of assignList) {
    try {
      console.log(`[scrape]   ↳ assign: ${href}`);
      await workPage.goto(href, { waitUntil: 'domcontentloaded', timeout });
      await workPage.waitForTimeout(500);
      const detail = await workPage.evaluate(() => {
        const descNode = document.querySelector(
          '#region-main .activity-description, .activity-description, [data-region="activity-description"]'
        );
        const descRaw = String(descNode?.innerText || '');
        const desc = descRaw.replace(/\s+/g, ' ').trim().slice(0, 800);

        // Moodle: tanggal di .activity-dates; fallback region-main (pertahankan newline)
        const datesRoot =
          document.querySelector(
            '#region-main .activity-dates, .activity-dates, .assignment-status'
          ) || document.querySelector('#region-main') || document.body;
        const datesText = String(datesRoot.innerText || '').slice(0, 4000);

        function pickDate(labels) {
          for (const label of labels) {
            const re = new RegExp(`${label}\\s*:\\s*([^\\n\\r]+)`, 'i');
            const hit = datesText.match(re) || descRaw.match(re);
            if (hit) {
              return String(hit[1] || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120);
            }
          }
          return '';
        }

        const opened = pickDate([
          'Opened',
          'Dibuka',
          'Allow submissions from',
          'Mulai',
        ]);
        const due = pickDate([
          'Due date',
          'Due',
          'Ditutup',
          'Tenggat',
          'Cutoff date',
          'Cutoff',
        ]);

        const idMatch = location.href.match(/[?&]id=(\d+)/i);
        return {
          id: idMatch ? idMatch[1] : '',
          href: location.href,
          type: 'tugas',
          desc,
          opened,
          due,
          deadline: due || '',
        };
      });

      combinedText += `\n=== ASSIGN_DETAIL: __ASSIGN__ ===\n- ITEM_JSON:${JSON.stringify(detail)}\n`;
    } catch (err) {
      console.warn(`[scrape]   assign gagal (${href}): ${err.message}`);
    }
  }

  console.log(`[scrape] Total teks dikumpulkan: ${combinedText.length} karakter`);

  if (combinedText.length < 80) {
    throw new Error(
      'Konten E-Learning terlalu pendek. Pastikan login sukses dan ELEARNING_URL benar.'
    );
  }

  return {
    text: combinedText,
    html: '',
    title: dashboard.title,
    url: dashboard.url,
  };
}

module.exports = { loginPortal, scrapeElearning };
