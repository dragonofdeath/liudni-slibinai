import { items } from "@wix/data";
import { auth } from "@wix/essentials";

// Collections seeded by scripts/migrate-wp.mjs. Bodies are migrated WordPress
// HTML stored in plain TEXT fields — render with set:html, not renderRicos.

export interface Post {
  _id: string;
  title: string;
  slug: string;
  date: string; // ISO string
  categories?: string;
  excerpt?: string;
  body: string;
  coverImage?: string;
}

export interface Song {
  _id: string;
  title: string;
  slug: string;
  body: string;
}

export interface StaticPage {
  _id: string;
  title: string;
  slug: string;
  body: string;
}

export interface Album {
  _id: string;
  title: string;
  slug: string;
  year?: string;
  description?: string;
  cover?: string;
  spotifyUrl?: string;
  itunesUrl?: string;
  soundcloudUrl?: string;
  deezerUrl?: string;
  buyUrl?: string;
  detailSlug?: string;
  sortOrder?: number;
}

export interface Video {
  _id: string;
  title: string;
  youtubeId: string;
  section?: string;
  sortOrder?: number;
}

export interface Gallery {
  _id: string;
  title: string;
  slug: string;
  images: string; // JSON-encoded array of image URLs
  sortOrder?: number;
}

const query = auth.elevate(items.query);

async function safeFind<T>(build: () => Promise<{ items: unknown[] }>): Promise<T[]> {
  try {
    const { items: results } = await build();
    return results as T[];
  } catch (err) {
    console.error("[cms] query failed:", err);
    return [];
  }
}

// listing projection — bodies are only fetched on the detail page
export const getPosts = (limit = 100, skip = 0) =>
  safeFind<Post>(() =>
    query("posts")
      .fields("title", "slug", "date", "categories", "excerpt", "coverImage")
      .descending("date")
      .skip(skip)
      .limit(limit)
      .find()
  );

export const getPostBySlug = async (slug: string) =>
  (await safeFind<Post>(() => query("posts").eq("slug", slug).limit(1).find()))[0] ?? null;

export const getSongs = () =>
  safeFind<Song>(() => query("songs").fields("title", "slug").ascending("title").limit(200).find());

export const getSongBySlug = async (slug: string) =>
  (await safeFind<Song>(() => query("songs").eq("slug", slug).limit(1).find()))[0] ?? null;

export const getPageBySlug = async (slug: string) =>
  (await safeFind<StaticPage>(() => query("pages").eq("slug", slug).limit(1).find()))[0] ?? null;

export const getAlbums = () =>
  safeFind<Album>(() => query("albums").ascending("sortOrder").limit(50).find());

export const getVideos = () =>
  safeFind<Video>(() => query("videos").ascending("sortOrder").limit(200).find());

export const getGalleries = () =>
  safeFind<Gallery>(() => query("galleries").ascending("sortOrder").limit(100).find());

export const getGalleryBySlug = async (slug: string) =>
  (await safeFind<Gallery>(() => query("galleries").eq("slug", slug).limit(1).find()))[0] ?? null;

export function galleryImages(g: Gallery): string[] {
  try {
    return JSON.parse(g.images);
  } catch {
    return [];
  }
}

export const formatDate = (iso?: string) => (iso ? iso.slice(0, 10).replaceAll("-", " ") : "");
