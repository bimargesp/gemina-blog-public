// Router del blog: gemina.ar/blog* se sirve desde el proyecto Pages "gemina-blog"
// (generado desde Notion por GitHub Actions en bimargesp/gemina-blog-public).
// Si un archivo no existe ahí (404) o el proyecto falla (5xx), cae al sitio principal (proyecto Pages "gemina").
// Copia del Worker bimarg-blog-router. Rutas: gemina.ar/blog* y www.gemina.ar/blog*.
const BLOG = 'https://gemina-blog.pages.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' || request.method === 'HEAD') {
      // /blog sin barra → /blog/ (una sola URL canónica)
      if (url.pathname === '/blog') return Response.redirect(url.origin + '/blog/' + url.search, 301);
      const r = await fetch(BLOG + url.pathname + url.search, { method: request.method, headers: request.headers, redirect: 'manual' });
      if (r.status !== 404 && r.status < 500) {
        const h = new Headers(r.headers);
        const loc = h.get('location');
        if (loc && loc.startsWith(BLOG)) h.set('location', loc.replace(BLOG, url.origin));
        return new Response(r.body, { status: r.status, headers: h });
      }
    }
    return fetch(request);
  }
};
