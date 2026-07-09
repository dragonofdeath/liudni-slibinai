import { defineMiddleware } from "astro:middleware";

// Content changes rarely (a few posts a year) — let the CDN serve cached HTML
// and revalidate in the background. Browsers always revalidate (max-age=0).
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  if (context.request.method === "GET" && response.headers.get("content-type")?.includes("text/html")) {
    response.headers.set(
      "Cache-Control",
      "public, max-age=0, s-maxage=600, stale-while-revalidate=300"
    );
  }
  return response;
});
