# Gémina Blog

Blog estático de **gemina.ar/blog**, generado automáticamente desde Notion. Es una copia del blog de BIMARG (`bimargesp/bimarg-blog-public`): misma base de datos, mismo flujo y mismo deploy, con la identidad de Gémina.

**Stack:** Node.js + Notion API + GitHub Actions + Cloudflare Pages (proyecto `gemina-blog`) + Worker `gemina-blog-router`.

Cada vez que publicás un post en Notion (Estado = Publicado), la Action arma el HTML y lo publica en `gemina.ar/blog`. Corre sola a las 09:00 y 18:00 (hora argentina). Para publicar al instante: GitHub → Actions → **Deploy Blog Gémina** → **Run workflow**.

---

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| Contenido | Notion: GÉMINA › CCO · Comercial › Marketing › BLOG › **📝 Blog Gémina** |
| Build | `build.js` (este repo) |
| Hosting | Cloudflare Pages `gemina-blog` (`gemina-blog.pages.dev/blog/`) |
| Dominio | Worker `gemina-blog-router` en las rutas `gemina.ar/blog*` y `www.gemina.ar/blog*` (código en `worker/router.js`) |
| Sitio principal | Cloudflare Pages `gemina` (no se toca desde acá) |

El Worker sirve `/blog/*` desde `gemina-blog` y, si un archivo no existe ahí (404) o el proyecto falla (5xx), deja pasar el pedido al sitio principal.

---

## Setup (una sola vez)

1. **Notion:** en la base **📝 Blog Gémina** → `•••` → **Connections** → agregar la integración del blog (se puede usar la misma "BIMARG Blog"). Sin esto la API no ve la base.
2. **GitHub:** crear el repo `bimargesp/gemina-blog-public` y subir este código.
3. **Secrets** (repo → Settings → Secrets and variables → Actions):

| Secret | Valor |
|---|---|
| `NOTION_API_KEY` | Token de la integración de Notion (el mismo del blog de BIMARG si se reutiliza) |
| `NOTION_DATABASE_ID` | `d1edac9331824a20b3319126e61e3218` |
| `CLOUDFLARE_API_TOKEN` | Token con permiso **Pages: Edit** (el mismo de `bimarg-blog-public`) |

4. **Worker router:** crear el Worker `gemina-blog-router` con `worker/router.js` y agregarle las rutas `gemina.ar/blog*` y `www.gemina.ar/blog*` (zona gemina.ar). Con Wrangler:

```bash
npx wrangler@4 deploy worker/router.js --name gemina-blog-router --compatibility-date 2026-10-01 --route "gemina.ar/blog*" --route "www.gemina.ar/blog*"
```

5. Correr la Action una vez (Run workflow) y verificar `https://gemina.ar/blog/`.
6. **Google Search Console:** agregar `https://gemina.ar/blog/sitemap.xml`.

---

## Uso diario

1. Abrir **📝 Blog Gémina** en Notion y crear una página nueva.
2. Completar: Título, Slug, Descripción (140-160 caracteres), Categoría, Fecha de Publicación, Imagen de Portada (WebP 1200 px, `slug-cover.webp`).
3. Escribir el contenido con bloques normales de Notion. `#` = sección (h2), `##` = subsección (h3). Tablas, toggles y columnas no se publican.
4. Revisar contra la guía de publicación y las reglas de coherencia (página BLOG en Notion).
5. Estado = **Publicado**. Aparece en la próxima corrida (09:00 o 18:00) o al instante con Run workflow.

---

## Qué genera el build

- `/blog/` índice con filtro por categoría, `/blog/<slug>/` cada post.
- Canónico `https://gemina.ar/...`, Open Graph, JSON-LD (`Blog`, `BlogPosting`, `BreadcrumbList`).
- `/blog/sitemap.xml` y `/blog/feed.xml` (RSS).
- Imágenes de Notion descargadas a `/blog/images/` (las URLs de Notion vencen).
- Si dos posts publicados tienen el mismo slug, el build se corta y no publica.

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar NOTION_API_KEY y NOTION_DATABASE_ID
npm run build          # salida en dist/blog/
```

## Modificar el diseño

- Colores y tipografía: `assets/style.css` (mismos tokens que gemina.ar).
- Grilla: `indexTemplate()` en `build.js`. Post: `postTemplate()`. CTA: `ctaHtml()`.
- Logo: `partials/logo-symbols.svg` (símbolos `isologo` e `isotipo` de la home).
