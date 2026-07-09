# liūdni slibinai — band website

The website of **liūdni slibinai** (liudnislibinai.lt) — a melancholic-ironic Lithuanian
„grupė“ singing the texts of classic Lithuanian poets, active since 2008.

Built with [Astro](https://astro.build) on [Wix Managed Headless](https://dev.wix.com/docs/go-headless):
content lives in Wix CMS collections, the site is server-rendered and hosted on Wix infrastructure.

## Structure

- `src/pages/` — routes: home, `naujienos` (news + detail), `albumai`, `video`, `foto`
  (galleries + detail), `tekstai` (lyrics + detail), `apie`, `kontaktai`, `en`, `p/[slug]`
  (misc migrated pages)
- `src/lib/cms.ts` — typed `@wix/data` queries for the CMS collections
  (`posts`, `songs`, `pages`, `albums`, `videos`, `galleries`)
- `scripts/migrate-wp.mjs` — one-off migration from the old WordPress site
  (posts, lyrics, pages, albums, video embeds, NextGEN galleries + all media into Wix Media)

## Development

```bash
npm install
npm run dev        # local dev against the live Wix site
npm run release    # build + publish to Wix hosting
```

Content is edited in the Wix dashboard (CMS). To re-run the WordPress migration:

```bash
node scripts/migrate-wp.mjs --wipe
```
