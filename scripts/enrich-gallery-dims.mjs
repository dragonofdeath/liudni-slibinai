#!/usr/bin/env node
/**
 * One-off: add width/height to every gallery photo so <img> tags can reserve
 * space (no layout shift). Lists all files in the Wix Media manager, maps
 * URL -> dimensions, and rewrites the `galleries` collection's `images` field
 * from ["url", ...] to [{"url","w","h"}, ...].
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SITE_ID = JSON.parse(readFileSync(new URL("../wix.config.json", import.meta.url), "utf8")).siteId;
const TOKEN = execSync(`npx @wix/cli@latest token --site "${SITE_ID}"`, { encoding: "utf8" }).trim();
const H = { Authorization: `Bearer ${TOKEN}`, "wix-site-id": SITE_ID, "Content-Type": "application/json" };

async function api(method, path, body) {
  const res = await fetch(`https://www.wixapis.com${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// 1. list all media files → url -> {w,h}
const dims = {};
let cursor, pages = 0;
do {
  const q = cursor ? `paging.cursor=${encodeURIComponent(cursor)}` : "paging.limit=100";
  const j = await api("GET", `/site-media/v1/files?${q}`);
  for (const f of j.files || []) {
    const img = f.media?.image?.image;
    if (img?.width && img?.height) dims[f.url] = { w: img.width, h: img.height };
  }
  cursor = j.nextCursor?.cursors?.next;
  pages++;
} while (cursor);
console.log(`media files with dims: ${Object.keys(dims).length} (${pages} pages)`);

// 2. rewrite galleries.images with dimensions
let gCursor, updated = 0, missing = 0;
do {
  const res = await api("POST", "/wix-data/v2/items/query", {
    dataCollectionId: "galleries",
    query: { cursorPaging: { limit: 100, ...(gCursor ? { cursor: gCursor } : {}) } },
  });
  for (const item of res.dataItems) {
    const images = JSON.parse(item.data.images).map((entry) => {
      const url = typeof entry === "string" ? entry : entry.url;
      const d = dims[url];
      if (!d) missing++;
      return d ? { url, w: d.w, h: d.h } : { url };
    });
    await api("PUT", `/wix-data/v2/items/${item.id}`, {
      dataCollectionId: "galleries",
      dataItem: { id: item.id, data: { ...item.data, images: JSON.stringify(images) } },
    });
    updated++;
  }
  gCursor = res.pagingMetadata?.cursors?.next;
} while (gCursor);
console.log(`galleries updated: ${updated}; photos without dims: ${missing}`);
