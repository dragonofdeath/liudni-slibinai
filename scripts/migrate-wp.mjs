#!/usr/bin/env node
/**
 * One-off migration: liudnislibinai.lt (WordPress) → Wix CMS collections.
 *
 * Sources (WP REST API + public pages):
 *   - posts (news)            → collection `posts`
 *   - lyrics pages            → collection `songs`   (pages linked from Tekstai index, page_id=12)
 *   - other pages             → collection `pages`
 *   - albums (curated below)  → collection `albums`
 *   - video page embeds       → collection `videos`  (page_id=558)
 *   - NextGEN photo galleries → collection `galleries` (scraped from ?p=977 gallery pages)
 *
 * All referenced images are imported into Wix Media (POST /site-media/v1/files/import)
 * and URLs are rewritten. Imports are cached in scripts/.wp-media-cache.json so
 * re-runs don't re-import. Internal ?p=/?page_id= links are rewritten to new routes.
 *
 * Usage: node scripts/migrate-wp.mjs [--wipe]   (--wipe deletes existing items first)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WP = "https://www.liudnislibinai.lt";
const CACHE_FILE = join(ROOT, "scripts", ".wp-media-cache.json");
const WIPE = process.argv.includes("--wipe");

const SITE_ID = JSON.parse(readFileSync(join(ROOT, "wix.config.json"), "utf8")).siteId;
console.log(`site: ${SITE_ID}`);
const TOKEN = execSync(`npx @wix/cli@latest token --site "${SITE_ID}"`, { encoding: "utf8" }).trim();

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wixApi(method, path, body, attempt = 0) {
  const res = await fetch(`https://www.wixapis.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "wix-site-id": SITE_ID,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(res.status === 429 ? 8000 * (attempt + 1) : 1500 * (attempt + 1));
      return wixApi(method, path, body, attempt + 1);
    }
    const err = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function wpFetch(route, attempt = 0) {
  const res = await fetch(`${WP}/index.php?rest_route=${route}`);
  if (!res.ok) {
    if (attempt < 3) { await sleep(1000); return wpFetch(route, attempt + 1); }
    throw new Error(`WP ${route} → ${res.status}`);
  }
  return res.json();
}

async function wpFetchAll(type) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await wpFetch(`/wp/v2/${type}&per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function fetchHtml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#8211;/g, "–")
    .replace(/&#8230;/g, "…").replace(/&#8220;/g, "“").replace(/&#8221;/g, "”");

const LT_MAP = { ą: "a", č: "c", ę: "e", ė: "e", į: "i", š: "s", ų: "u", ū: "u", ž: "z" };
function slugify(title) {
  return decodeEntities(title)
    .toLowerCase()
    .replace(/[ąčęėįšųūž]/g, (c) => LT_MAP[c])
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// ── media import with cache ──────────────────────────────────────────────────
const mediaCache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
let cacheDirty = 0;
const saveCache = () => writeFileSync(CACHE_FILE, JSON.stringify(mediaCache, null, 1));

const normUrl = (u) =>
  u.replace(/^http:/, "https:").replace("https://liudnislibinai.lt", `https://www.liudnislibinai.lt`)
    .replace(".lt//", ".lt/").split("?")[0];

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

async function importImage(rawUrl) {
  const url = normUrl(rawUrl);
  if (mediaCache[url] && !mediaCache[url].failed) return mediaCache[url];
  const ext = (url.split(".").pop() || "").toLowerCase();
  if (!MIME[ext]) return null;
  const displayName = decodeURIComponent(url.split("/").pop());
  try {
    const res = await wixApi("POST", "/site-media/v1/files/import", {
      url, mimeType: MIME[ext], displayName,
    });
    const entry = { url: res.file?.url, fileId: res.file?.id };
    if (!entry.url) throw new Error(`no file.url in response`);
    mediaCache[url] = entry;
    if (++cacheDirty % 20 === 0) saveCache();
    return entry;
  } catch (e) {
    console.warn(`  ! image import failed, keeping original: ${url} (${e.message.slice(0, 120)})`);
    mediaCache[url] = { url, failed: true };
    return mediaCache[url];
  }
}

async function pool(items, worker, concurrency = 6) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    })
  );
  return results;
}

// ── HTML cleanup + rewriting ─────────────────────────────────────────────────
function collectImageUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    if (m[1].includes("liudnislibinai.lt")) urls.add(normUrl(m[1]));
  }
  return [...urls];
}

function cleanHtml(html, linkMap) {
  let out = html;
  out = out.replace(/<!--more-->/g, "");
  // email-protect plugin images → plain mailto links
  out = out.replace(/<img[^>]+email-protect[^>]*id=([A-Za-z0-9+/=]+)[^>]*>/g, (_, b64) => {
    try {
      const email = Buffer.from(decodeURIComponent(b64), "base64").toString("utf8");
      return `<a href="mailto:${email}">${email}</a>`;
    } catch { return ""; }
  });
  out = out.replace(/\s(?:srcset|sizes|loading|decoding|width|height|class|style|title)="[^"]*"/g, "");
  // rewrite image srcs to imported wix media
  out = out.replace(/(<img[^>]+src=")([^"]+)(")/g, (_, a, src, b) => {
    const hit = mediaCache[normUrl(src)];
    return a + (hit && !hit.failed ? hit.url : src) + b;
  });
  // links that point at wp-content images → imported media (lightbox-style links)
  out = out.replace(/(<a[^>]+href=")([^"]*wp-content[^"]*)(")/g, (_, a, href, b) => {
    const hit = mediaCache[normUrl(href)];
    return a + (hit && !hit.failed ? hit.url : href) + b;
  });
  // internal ?p= / ?page_id= links → new routes
  out = out.replace(/(<a[^>]+href=")([^"]+)(")/g, (_, a, href, b) => {
    const m = href.match(/liudnislibinai\.lt\/?\?(?:p|page_id)=(\d+)/) || href.match(/^\?(?:p|page_id)=(\d+)$/);
    if (m && linkMap[m[1]]) return a + linkMap[m[1]] + b;
    return a + href + b;
  });
  // strip empty paragraphs
  out = out.replace(/<p[^>]*>(?:\s|&nbsp;|<strong>\s*<\/strong>)*<\/p>/g, "");
  return out.trim();
}

// ── collections ──────────────────────────────────────────────────────────────
const COLLECTIONS = {
  posts: [
    ["title", "TEXT"], ["slug", "TEXT"], ["date", "TEXT"], ["categories", "TEXT"],
    ["excerpt", "TEXT"], ["body", "TEXT"], ["coverImage", "IMAGE"],
  ],
  songs: [["title", "TEXT"], ["slug", "TEXT"], ["body", "TEXT"]],
  pages: [["title", "TEXT"], ["slug", "TEXT"], ["body", "TEXT"]],
  albums: [
    ["title", "TEXT"], ["slug", "TEXT"], ["year", "TEXT"], ["description", "TEXT"],
    ["cover", "IMAGE"], ["spotifyUrl", "URL"], ["itunesUrl", "URL"], ["soundcloudUrl", "URL"],
    ["deezerUrl", "URL"], ["buyUrl", "URL"], ["detailSlug", "TEXT"], ["sortOrder", "NUMBER"],
  ],
  videos: [["title", "TEXT"], ["youtubeId", "TEXT"], ["section", "TEXT"], ["sortOrder", "NUMBER"]],
  galleries: [["title", "TEXT"], ["slug", "TEXT"], ["images", "TEXT"], ["sortOrder", "NUMBER"]],
};

async function ensureCollection(id, fields) {
  try {
    await wixApi("POST", "/wix-data/v2/collections", {
      collection: {
        id,
        displayName: id[0].toUpperCase() + id.slice(1),
        fields: fields.map(([key, type]) => ({ key, displayName: key, type })),
      },
    });
    console.log(`collection created: ${id}`);
  } catch (e) {
    if (e.status === 409 || /ALREADY_EXISTS|already exists/i.test(JSON.stringify(e.body))) {
      console.log(`collection exists: ${id}`);
    } else throw e;
  }
}

async function queryAll(collectionId) {
  const items = [];
  let cursor;
  do {
    const body = { dataCollectionId: collectionId, query: { cursorPaging: { limit: 500, ...(cursor ? { cursor } : {}) } } };
    const res = await wixApi("POST", "/wix-data/v2/items/query", body);
    items.push(...(res.dataItems || []));
    cursor = res.pagingMetadata?.cursors?.next;
  } while (cursor);
  return items;
}

async function wipeCollection(id) {
  const existing = await queryAll(id);
  if (!existing.length) return;
  for (let i = 0; i < existing.length; i += 500) {
    await wixApi("POST", "/wix-data/v2/bulk/items/remove", {
      dataCollectionId: id,
      dataItemIds: existing.slice(i, i + 500).map((it) => it.id),
    });
  }
  console.log(`wiped ${existing.length} items from ${id}`);
}

async function bulkInsert(collectionId, datas) {
  let inserted = 0;
  for (let i = 0; i < datas.length; i += 500) {
    const res = await wixApi("POST", "/wix-data/v2/bulk/items/insert", {
      dataCollectionId: collectionId,
      dataItems: datas.slice(i, i + 500).map((data) => ({ data })),
      returnEntity: false,
    });
    inserted += (res.bulkActionMetadata?.totalSuccesses ?? 0);
  }
  return inserted;
}

// ── curated albums (parsed from the old Albumai page, ?p=964) ────────────────
const ALBUMS = [
  {
    title: "Albumas, raginantis tautą (A.R.T.)", year: "2010", sortOrder: 4,
    description: "Debiutinis „Liūdnų slibinų“ albumas, išleistas 2010 metais.",
    coverWp: `${WP}/wp-content/uploads/2013/08/Albumas-raginantis-tauta-virselis.jpg`,
    soundcloudUrl: "https://soundcloud.com/li-dni-slibinai/sets/albumas-raginantis-tauta",
    itunesUrl: "https://itunes.apple.com/us/album/albumas-raginantis-tauta/id978798465",
    spotifyUrl: "https://open.spotify.com/album/1jNH1f67z3AWa7TXMHCwQQ",
    detailWpId: "198",
  },
  {
    title: "Albumas be jokių Ė", year: "2012", sortOrder: 3,
    description: "Antrasis „Liūdnų slibinų“ albumas, išleistas 2012 m. spalio mėnesį, kviečiantis išsivalyti nuo dvasios konservantų.",
    coverWp: `${WP}/wp-content/uploads/2013/08/Albumas-be-jokiu-E-virselis.jpg`,
    itunesUrl: "https://itunes.apple.com/us/album/albumas-be-jokiu-e/id569776511",
    spotifyUrl: "https://open.spotify.com/artist/6zjXlMyonWlkxRMNrlOIrR",
    detailWpId: "685",
  },
  {
    title: "Imkit mane ir klausykit", year: "2013", sortOrder: 2,
    description: "Penktojo „Liūdnų slibinų“ gimtadienio proga pristatytas dainų rinkinys pagal Lietuvos klasikų poetų kūrybą.",
    coverWp: `${WP}/wp-content/uploads/2013/08/IMIK-paradas.png`,
    itunesUrl: "https://itunes.apple.com/us/album/imkit-mane-ir-klausykit/id736472668",
    spotifyUrl: "https://open.spotify.com/album/1je6LtMWBb1QXujBf7ieMN",
    deezerUrl: "https://www.deezer.com/album/7449016",
    detailWpId: "1179",
  },
  {
    title: "Viskas netrukus baigsis", year: "2015", sortOrder: 1,
    description: "Ketvirtasis „Liūdnų slibinų“ albumas, kurį sudaro vien Aistės Lasytės, Vaido Kublinsko ir Dominyko Vaitiekūno autorinė kūryba apie įvairias gyvenimo pabaigas. 2026 m. išleistas ir vinilinės plokštelės formatu.",
    coverWp: `${WP}/wp-content/uploads/2015/10/Albumo-virselis1.jpg`,
    itunesUrl: "https://itunes.apple.com/ca/album/viskas-netrukus-baigsis/id1050145632",
    spotifyUrl: "https://open.spotify.com/album/0PfF6qaOgcbyMT5eFcFsyk",
    deezerUrl: "https://www.deezer.com/album/11443208",
    buyUrl: "https://greenlp.lt",
    detailWpId: "1679",
  },
];

// ── main ─────────────────────────────────────────────────────────────────────
console.log("fetching WordPress content…");
const [posts, wpPages, categories] = await Promise.all([
  wpFetchAll("posts"),
  wpFetchAll("pages"),
  wpFetchAll("categories"),
]);
console.log(`  ${posts.length} posts, ${wpPages.length} pages, ${categories.length} categories`);
const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));

// classify pages: lyrics = pages linked from the Tekstai index (page 12)
const tekstaiIndex = wpPages.find((p) => p.id === 12);
const lyricIds = new Set(
  [...tekstaiIndex.content.rendered.matchAll(/page_id=(\d+)/g)].map((m) => Number(m[1]))
);
// pages that become dedicated site pages instead of CMS content
const SKIP_PAGES = new Set([12, 558, 6, 1371]); // Tekstai index, Video, Foto, order-confirmation
const lyricPages = wpPages.filter((p) => lyricIds.has(p.id));
const otherPages = wpPages.filter((p) => !lyricIds.has(p.id) && !SKIP_PAGES.has(p.id));
console.log(`  ${lyricPages.length} lyric pages, ${otherPages.length} other pages`);

// videos from page 558: headings + iframes in document order
const videoHtml = wpPages.find((p) => p.id === 558).content.rendered;
const videos = [];
{
  let section = "Dainos";
  let lastTitle = "";
  const tokens = videoHtml.split(/(<iframe[^>]*>|<\/iframe>)/);
  for (const tok of tokens) {
    const src = tok.match(/^<iframe[^>]*src="([^"]+)"/)?.[1];
    if (src) {
      const id = src.match(/(?:embed\/|v=)([\w-]{6,})/)?.[1];
      if (id) videos.push({ title: lastTitle || `Video ${videos.length + 1}`, youtubeId: id, section, sortOrder: videos.length + 1 });
      lastTitle = "";
    } else {
      const text = stripTags(tok);
      if (/^DAINOS/i.test(text)) section = "Dainos";
      else if (/^REKLAMOS/i.test(text)) section = "Reklamos (ir ne tik)";
      else if (/^KITA/i.test(text)) section = "Kita";
      const t = text.match(/„([^“”]+)[“”]/)?.[1] || text;
      if (t && t.length > 2 && t.length < 120) lastTitle = t.trim();
    }
  }
}
console.log(`  ${videos.length} videos parsed`);

// galleries from the Foto post (?p=977): title + gallery id pairs, then scrape each
const fotoHtml = posts.find((p) => p.id === 977).content.rendered;
const galleryDefs = [];
{
  const seen = new Set();
  const blocks = fotoHtml.split(/<\/a>/);
  let pendingTitle = "";
  for (const b of fotoHtml.split(/(?=<)/).join("").split("\n").length ? [fotoHtml] : []) void b;
  // simpler: match "title ... gallery=N" proximity via ordered scan
  const re = /(?:>([^<>]{3,80})<)|gallery=(\d+)/g;
  for (const m of fotoHtml.matchAll(re)) {
    if (m[1] && stripTags(m[1]).length > 2 && !/^(–|-->|\s*)$/.test(stripTags(m[1]))) pendingTitle = stripTags(m[1]);
    if (m[2] && !seen.has(m[2])) {
      seen.add(m[2]);
      galleryDefs.push({ id: m[2], title: pendingTitle || `Galerija ${m[2]}` });
    }
  }
}
console.log(`  ${galleryDefs.length} galleries found: ${galleryDefs.map((g) => g.title).join(" | ").slice(0, 200)}`);

console.log("scraping gallery pages…");
const galleries = await pool(galleryDefs, async (g, i) => {
  const html = await fetchHtml(`${WP}/?p=977&album=1&gallery=${g.id}`);
  const imgs = [...new Set(
    [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]*wp-content\/gallery\/[^"]+)"/g)]
      .map((m) => normUrl(m[1]))
      .filter((u) => !u.includes("/thumbs/"))
  )];
  return { title: g.title, slug: slugify(g.title), images: imgs, sortOrder: i + 1 };
}, 4);
console.log(`  ${galleries.reduce((n, g) => n + g.images.length, 0)} gallery photos total`);

// ── build link map (old wp id → new route) ───────────────────────────────────
const usedSlugs = new Set();
const uniqueSlug = (s) => {
  let out = s, n = 2;
  while (usedSlugs.has(out)) out = `${s}-${n++}`;
  usedSlugs.add(out);
  return out;
};
const postRecords = posts.map((p) => ({
  wpId: p.id,
  title: stripTags(p.title.rendered),
  slug: uniqueSlug(slugify(p.title.rendered)),
  date: p.date,
  categories: (p.categories || []).map((c) => catName[c]).filter(Boolean).join(", "),
  excerpt: stripTags(p.excerpt?.rendered || "").replace(/\s*(Skaityti daugiau|Read more).*$/i, "").slice(0, 300),
  rawHtml: p.content.rendered,
}));
const songRecords = lyricPages.map((p) => ({
  wpId: p.id,
  title: stripTags(p.title.rendered),
  slug: uniqueSlug(slugify(p.title.rendered)),
  rawHtml: p.content.rendered,
}));
const pageRecords = otherPages.map((p) => ({
  wpId: p.id,
  title: stripTags(p.title.rendered),
  slug: uniqueSlug(slugify(p.title.rendered)),
  rawHtml: p.content.rendered,
}));
// nav posts Apie (955) & Kontaktai (946) become static pages with fixed slugs
for (const [wpId, slug] of [[955, "apie"], [946, "kontaktai"]]) {
  const p = posts.find((x) => x.id === wpId);
  if (p) {
    usedSlugs.add(slug);
    pageRecords.push({ wpId, title: stripTags(p.title.rendered), slug, rawHtml: p.content.rendered });
  }
}

const linkMap = {};
for (const r of postRecords) linkMap[r.wpId] = `/naujienos/${r.slug}`;
for (const r of songRecords) linkMap[r.wpId] = `/tekstai/${r.slug}`;
for (const r of pageRecords) linkMap[r.wpId] = `/p/${r.slug}`;
linkMap["977"] = "/foto"; linkMap["964"] = "/albumai"; linkMap["955"] = "/apie";
linkMap["946"] = "/kontaktai"; linkMap["12"] = "/tekstai"; linkMap["558"] = "/video";
linkMap["1223"] = "/en"; linkMap["6"] = "/foto";

// special routes: apie/kontaktai/albumai are posts — pull them out of the news feed
const SPECIAL_POST_IDS = new Set([964, 977, 955, 946]);
const newsRecords = postRecords.filter((r) => !SPECIAL_POST_IDS.has(r.wpId));

// ── import all images ────────────────────────────────────────────────────────
const allImageUrls = new Set();
for (const r of [...postRecords, ...songRecords, ...pageRecords]) {
  for (const u of collectImageUrls(r.rawHtml)) allImageUrls.add(u);
}
for (const g of galleries) for (const u of g.images) allImageUrls.add(u);
for (const a of ALBUMS) allImageUrls.add(normUrl(a.coverWp));
const toImport = [...allImageUrls];
console.log(`importing ${toImport.length} images to Wix Media (cached: ${Object.keys(mediaCache).length})…`);
let done = 0;
await pool(toImport, async (u) => {
  await importImage(u);
  if (++done % 50 === 0) console.log(`  ${done}/${toImport.length}`);
}, 3);
saveCache();
const failed = toImport.filter((u) => mediaCache[u]?.failed);
console.log(`images done (${failed.length} failed, originals kept)`);

// ── seed collections ─────────────────────────────────────────────────────────
for (const [id, fields] of Object.entries(COLLECTIONS)) await ensureCollection(id, fields);
if (WIPE) for (const id of Object.keys(COLLECTIONS)) await wipeCollection(id);

const counts = {};
counts.posts = await bulkInsert("posts", newsRecords.map((r) => ({
  title: r.title, slug: r.slug, date: r.date, categories: r.categories,
  excerpt: r.excerpt, body: cleanHtml(r.rawHtml, linkMap),
  coverImage: (() => {
    const first = collectImageUrls(r.rawHtml)[0];
    const hit = first && mediaCache[first];
    return hit && !hit.failed ? hit.url : undefined;
  })(),
})));
counts.songs = await bulkInsert("songs", songRecords.map((r) => ({
  title: r.title, slug: r.slug, body: cleanHtml(r.rawHtml, linkMap),
})));
counts.pages = await bulkInsert("pages", pageRecords.map((r) => ({
  title: r.title, slug: r.slug, body: cleanHtml(r.rawHtml, linkMap),
})));
counts.albums = await bulkInsert("albums", ALBUMS.map((a) => ({
  title: a.title, slug: slugify(a.title), year: a.year, description: a.description,
  cover: mediaCache[normUrl(a.coverWp)]?.url,
  spotifyUrl: a.spotifyUrl, itunesUrl: a.itunesUrl, soundcloudUrl: a.soundcloudUrl,
  deezerUrl: a.deezerUrl, buyUrl: a.buyUrl,
  detailSlug: linkMap[a.detailWpId] || "", sortOrder: a.sortOrder,
})));
counts.videos = await bulkInsert("videos", videos);
counts.galleries = await bulkInsert("galleries", galleries.map((g) => ({
  title: g.title, slug: g.slug, sortOrder: g.sortOrder,
  images: JSON.stringify(g.images.map((u) => mediaCache[u] && !mediaCache[u].failed ? mediaCache[u].url : u)),
})));

// ── verify ───────────────────────────────────────────────────────────────────
console.log("\nverifying…");
const expected = {
  posts: newsRecords.length, songs: songRecords.length, pages: pageRecords.length,
  albums: ALBUMS.length, videos: videos.length, galleries: galleries.length,
};
let ok = true;
for (const id of Object.keys(COLLECTIONS)) {
  const stored = await queryAll(id);
  const status = stored.length >= expected[id] ? "✓" : "✗";
  if (stored.length < expected[id]) ok = false;
  console.log(`  ${status} ${id}: inserted=${counts[id]} stored=${stored.length} expected=${expected[id]}`);
  const sample = stored[0]?.data;
  if (sample) {
    const missing = Object.keys(sample).length < 3 && id !== "videos";
    if (missing) { ok = false; console.log(`    ✗ sample item looks empty: ${JSON.stringify(sample).slice(0, 150)}`); }
  }
}
console.log(ok ? "\nMigration complete ✓" : "\nMigration finished WITH GAPS ✗");
process.exit(ok ? 0 : 1);
