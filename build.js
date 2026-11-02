/**
 * Gémina Blog — Build Script v1 (30/10/2026)
 * Copia del build v4 del blog de BIMARG (bimargesp/bimarg-blog-public), con la
 * identidad de gemina.ar: misma base de Notion, mismo flujo, mismo deploy.
 *   - Lee posts de Notion (Estado = Publicado) y genera HTML estático en /dist/blog
 *   - Canónico https://gemina.ar, og:image, JSON-LD (Blog, BlogPosting, Breadcrumb)
 *   - Sitemap del blog (/blog/sitemap.xml) y feed RSS (/blog/feed.xml)
 *
 * Variables de entorno requeridas:
 *   NOTION_API_KEY     — token de la integración de Notion
 *   NOTION_DATABASE_ID — ID de la base de datos "📝 Blog Gémina"
 */

import { Client } from "@notionhq/client";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "dist");
const ASSETS = path.join(__dirname, "assets");
const BLOG_DIST = path.join(DIST, "blog");

// Dominio canónico: el mismo que usa la home de Gémina (sin www).
const SITE = "https://gemina.ar";
const BRAND = "Gémina";
const WHATSAPP = "https://wa.me/5492996287652";
const DEFAULT_AUTHOR = "Equipo Gémina";
// Imagen para compartir cuando un post no tiene portada. Copia propia (assets/og-default.jpg, sale de
// la og:image de la home al 02/11/2026): así el blog no depende de archivos de la home que pueden cambiar.
const DEFAULT_OG = `${SITE}/blog/og-default.jpg`;
// Misma entidad que el JSON-LD de la home (https://gemina.ar/#empresa). Mantener los datos iguales en los dos lados.
const ORG = { "@type": "GeneralContractor", "@id": `${SITE}/#empresa`, name: BRAND, url: `${SITE}/`, logo: `${SITE}/android-chrome-512x512.png` };
// Microsoft Clarity (proyecto z5ze96wfb9, cuenta bimarg.arq): el mismo tag que la home de gemina.ar.
// NO SACAR: sin esto el blog deja de medir. Aviso en /legales#privacidad.
const CLARITY = `<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "z5ze96wfb9");</script>`;
// Íconos del logo (isologo e isotipo), los mismos símbolos SVG de la home.
const LOGO_SYMBOLS = fs.readFileSync(path.join(__dirname, "partials", "logo-symbols.svg"), "utf8");

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// JSON dentro de <script type="application/ld+json">: evitar que "</script>" corte el bloque.
function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  timeoutMs: 300000 // 5 minutos en lugar de 1 minuto (por defecto)
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function retryWithExponentialBackoff(fn, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      const waitTime = delay * Math.pow(2, attempt - 1);
      console.log(`   ⚠️  Intento ${attempt} falló. Reintentando en ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

function writeFile(filepath, content) {
  ensureDir(path.dirname(filepath));
  fs.writeFileSync(filepath, content, "utf8");
  console.log(`  ✓ ${filepath.replace(__dirname, "")}`);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  // Fechas de Notion sin hora ("2026-10-31"): fijar mediodía para que la zona horaria no la corra un día.
  const d = new Date(dateStr.length === 10 ? dateStr + "T12:00:00" : dateStr);
  return d.toLocaleDateString("es-AR", { year: "numeric", month: "long", day: "numeric" });
}

function slugify(text) {
  return text.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

// Tope duro por imagen. Si una descarga no termina en este tiempo,
// se aborta y sigue el build (mismo criterio que el blog de BIMARG,
// incidente 17-19 ago 2026).
const IMG_TIMEOUT_MS = 15000;
const IMG_MAX_REDIRECTS = 3;

async function downloadImage(url, filename) {
  if (!url || !url.startsWith("http")) return null;

  const imgDir = path.join(BLOG_DIST, "images");
  ensureDir(imgDir);
  const extMatch = url.split("?")[0].toLowerCase().match(/\.(png|webp|jpe?g|gif)$/);
  const ext = extMatch ? (extMatch[1] === "jpeg" ? ".jpg" : "." + extMatch[1]) : ".jpg";
  const name = filename + ext;
  const dest = path.join(imgDir, name);
  const publicPath = `/blog/images/${name}`;

  if (fs.existsSync(dest)) return publicPath;

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let file = null;

    const cleanup = () => {
      if (req) { try { req.destroy(); } catch (e) {} }
      if (file) { try { file.destroy(); } catch (e) {} }
    };

    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      fs.unlink(dest, () => {});
      console.warn(`  [img] ${name}: ${reason}`);
      resolve(null);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(publicPath);
    };

    // Red de seguridad global: pase lo que pase, esto resuelve.
    const timer = setTimeout(() => fail(`timeout ${IMG_TIMEOUT_MS}ms`), IMG_TIMEOUT_MS);

    const get = (targetUrl, redirectsLeft) => {
      if (redirectsLeft < 0) { clearTimeout(timer); fail("demasiados redirects"); return; }

      req = https.get(targetUrl, { timeout: IMG_TIMEOUT_MS }, (res) => {
        const status = res.statusCode;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location, redirectsLeft - 1);
          return;
        }

        if (status !== 200) {
          res.resume();
          clearTimeout(timer);
          fail(`HTTP ${status}`);
          return;
        }

        file = fs.createWriteStream(dest);
        file.on("error", () => { clearTimeout(timer); fail("error de escritura"); });
        res.on("error", () => { clearTimeout(timer); fail("error de stream"); });
        file.on("finish", () => { file.close(); done(); });
        res.pipe(file);
      });

      req.on("timeout", () => { clearTimeout(timer); fail("socket timeout"); });
      req.on("error", (e) => { clearTimeout(timer); fail(e.message); });
    };

    get(url, IMG_MAX_REDIRECTS);
  });
}

// ─── Convertir bloques de Notion a HTML ────────────────────────────────────

function richTextToHtml(richTexts) {
  if (!richTexts || !richTexts.length) return "";
  return richTexts.map(rt => {
    let text = rt.plain_text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (rt.annotations) {
      if (rt.annotations.bold) text = `<strong>${text}</strong>`;
      if (rt.annotations.italic) text = `<em>${text}</em>`;
      if (rt.annotations.strikethrough) text = `<s>${text}</s>`;
      if (rt.annotations.code) text = `<code>${text}</code>`;
      if (rt.annotations.underline) text = `<u>${text}</u>`;
    }
    const href = safeHref(rt.href);
    if (href) {
      // Links internos (gemina.ar o rutas relativas) sin target _blank: mejor para SEO y navegación.
      const internal = href.startsWith("/") || href.startsWith(SITE);
      text = internal
        ? `<a href="${esc(href)}">${text}</a>`
        : `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
    }
    return text;
  }).join("");
}

// Solo esquemas seguros. Cualquier otro (javascript:, data:, etc.) se publica como texto sin link.
function safeHref(href) {
  const h = String(href || "").trim();
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  return /^(https?:|mailto:|tel:)/i.test(h) ? h : null;
}

function plainText(richTexts) {
  return (richTexts || []).map(rt => rt.plain_text).join("");
}

async function blockToHtml(block) {
  const type = block.type;
  const data = block[type];

  switch (type) {
    case "paragraph":
      const pText = richTextToHtml(data.rich_text);
      return pText ? `<p>${pText}</p>` : "";

    case "heading_1":
      return `<h2>${richTextToHtml(data.rich_text)}</h2>`;

    case "heading_2":
      return `<h3>${richTextToHtml(data.rich_text)}</h3>`;

    case "heading_3":
      return `<h4>${richTextToHtml(data.rich_text)}</h4>`;

    case "bulleted_list_item":
      return `<li>${richTextToHtml(data.rich_text)}</li>`;

    case "numbered_list_item":
      return `<li>${richTextToHtml(data.rich_text)}</li>`;

    case "to_do":
      const checked = data.checked ? "checked" : "";
      return `<li class="todo"><input type="checkbox" ${checked} disabled> ${richTextToHtml(data.rich_text)}</li>`;

    case "quote":
      return `<blockquote>${richTextToHtml(data.rich_text)}</blockquote>`;

    case "callout":
      const emoji = data.icon?.emoji || "💡";
      return `<div class="callout"><span class="callout-icon" aria-hidden="true">${esc(emoji)}</span><div>${richTextToHtml(data.rich_text)}</div></div>`;

    case "code":
      const lang = data.language || "";
      const code = data.rich_text.map(rt => rt.plain_text).join("").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code class="language-${esc(lang)}">${code}</code></pre>`;

    case "divider":
      return "<hr>";

    case "image": {
      const imgUrl = data.type === "external" ? data.external?.url : data.file?.url;
      const caption = data.caption?.length ? richTextToHtml(data.caption) : "";
      if (!imgUrl) return "";
      // Descargar la imagen durante el build para evitar URLs expiradas de Notion
      const localPath = await downloadImage(imgUrl, `content-${block.id}`);
      const finalSrc = localPath || imgUrl;
      return `<figure class="post-figure"><img src="${finalSrc}" alt="${esc(plainText(data.caption))}" loading="lazy">${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    }

    case "video":
      const videoUrl = data.type === "external" ? data.external?.url : data.file?.url;
      if (!videoUrl) return "";
      if (videoUrl.includes("youtube") || videoUrl.includes("youtu.be")) {
        const videoId = videoUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]+)/)?.[1];
        return videoId ? `<div class="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" title="Video" loading="lazy" frameborder="0" allowfullscreen></iframe></div>` : "";
      }
      return safeHref(videoUrl) ? `<video controls preload="metadata" src="${esc(videoUrl)}"></video>` : "";

    case "embed":
    case "bookmark":
      return safeHref(data.url) ? `<div class="bookmark"><a href="${esc(data.url)}" target="_blank" rel="noopener">${esc(data.url)}</a></div>` : "";

    case "table_of_contents":
    case "breadcrumb":
    case "child_database":
    case "child_page":
    case "unsupported":
      return "";

    default:
      return "";
  }
}

async function fetchAllBlocks(blockId) {
  const blocks = [];
  let cursor;
  do {
    const res = await retryWithExponentialBackoff(() => notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    }));
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  for (const block of blocks) {
    const type = block.type;
    if (block.has_children && type !== "child_database" && type !== "child_page") {
      block._children = await fetchAllBlocks(block.id);
    }
  }
  return blocks;
}

async function renderBlocks(blocks) {
  let html = "";
  let inBulletList = false;
  let inNumberedList = false;

  for (const block of blocks) {
    const type = block.type;
    const isBullet = type === "bulleted_list_item" || type === "to_do";
    const isNumbered = type === "numbered_list_item";

    if (!isBullet && inBulletList) { html += "</ul>"; inBulletList = false; }
    if (!isNumbered && inNumberedList) { html += "</ol>"; inNumberedList = false; }
    if (isBullet && !inBulletList) { html += "<ul>"; inBulletList = true; }
    if (isNumbered && !inNumberedList) { html += "<ol>"; inNumberedList = true; }

    html += await blockToHtml(block);

    if (block._children && block._children.length > 0) {
      html += await renderBlocks(block._children);
    }
  }

  if (inBulletList) html += "</ul>";
  if (inNumberedList) html += "</ol>";
  return html;
}

async function blocksToHtml(pageId) {
  const blocks = await fetchAllBlocks(pageId);
  return renderBlocks(blocks);
}

// ─── Leer posts de Notion ─────────────────────────────────────────────────

// Fecha de hoy en Argentina (UTC-3, sin horario de verano), formato AAAA-MM-DD.
// El runner de GitHub está en UTC: a las 21:00 de Argentina en UTC ya es el día siguiente.
function todayAR() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function fetchPosts() {
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error("NOTION_DATABASE_ID no está definida");

  // Paginado: la API devuelve como máximo 100 filas por consulta.
  const results = [];
  let cursor;
  do {
    const response = await retryWithExponentialBackoff(async () => {
      return await notion.databases.query({
        database_id: dbId,
        // Publicado y con fecha de hoy o anterior (hora Argentina): se pueden marcar varios
        // posts juntos y cada uno sale en la primera corrida de su fecha. Sin fecha, sale igual.
        filter: {
          and: [
            { property: "Estado", select: { equals: "Publicado" } },
            { or: [
              { property: "Fecha de Publicación", date: { on_or_before: todayAR() } },
              { property: "Fecha de Publicación", date: { is_empty: true } },
            ] },
          ],
        },
        sorts: [{ property: "Fecha de Publicación", direction: "descending" }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  const posts = [];

  for (const page of results) {
    const props = page.properties;

    const titulo = plainText(props["Título"]?.title) || "Sin título";
    const slugProp = plainText(props["Slug"]?.rich_text).trim();
    const slug = slugProp ? slugify(slugProp) : slugify(titulo);
    const descripcion = plainText(props["Descripción"]?.rich_text);
    const categoria = props["Categoría"]?.select?.name || BRAND;
    const autor = plainText(props["Autor"]?.rich_text) || DEFAULT_AUTHOR;
    const tiempoLectura = plainText(props["Tiempo de Lectura"]?.rich_text) || "4 min";
    const fechaRaw = props["Fecha de Publicación"]?.date?.start || page.created_time;
    const fecha = formatDate(fechaRaw);
    const editado = page.last_edited_time;
    // "Actualizado" solo si se editó al menos un día después de la fecha de publicación.
    const actualizado = editado && editado.slice(0, 10) > fechaRaw.slice(0, 10) ? formatDate(editado.slice(0, 10)) : "";

    const imagenFiles = props["Imagen de Portada"]?.files;
    let imagenUrl = null;
    if (imagenFiles && imagenFiles.length > 0) {
      const f = imagenFiles[0];
      imagenUrl = f.type === "external" ? f.external.url : f.file?.url;
    }

    let imagenLocal = null;
    if (imagenUrl) {
      imagenLocal = await downloadImage(imagenUrl, slug + "-cover");
    }

    const bodyHtml = await blocksToHtml(page.id);

    posts.push({ id: page.id, titulo, slug, descripcion, categoria, autor, tiempoLectura, fecha, fechaRaw, editado, actualizado, imagenLocal, bodyHtml });
  }

  return posts;
}

// ─── Templates ────────────────────────────────────────────────────────────

const ARROW = `<svg aria-hidden="true" viewBox="0 0 256 256"><path d="M40 128h176M144 56l72 72-72 72" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ISOLOGO = `<svg viewBox="233.17 115.79 932.68 193" aria-hidden="true"><use href="#isologo" x="233.17" y="115.79" width="932.68" height="193"/></svg>`;

function htmlShell({ title, description, canonical, content, extraHead = "", ogImage = DEFAULT_OG, ogType = "website" }) {
  title = esc(title);
  description = esc(description);
  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} | ${BRAND}</title>
  <meta name="description" content="${description}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <link rel="canonical" href="${SITE}${canonical}" />
  <meta property="og:title" content="${title} | ${BRAND}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:type" content="${ogType}" />
  <meta property="og:url" content="${SITE}${canonical}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:site_name" content="${BRAND}" />
  <meta property="og:locale" content="es_AR" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="#FFFFFF" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="alternate" type="application/rss+xml" title="Blog de ${BRAND}" href="${SITE}/blog/feed.xml" />
  <link rel="preconnect" href="https://api.fontshare.com" crossorigin />
  <link rel="preconnect" href="https://cdn.fontshare.com" crossorigin />
  <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" />
  <link rel="stylesheet" href="/blog/style.css" />
  ${CLARITY}
  ${extraHead}
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">${LOGO_SYMBOLS}</svg>
  <a class="skip" href="#contenido">Saltar al contenido</a>
  <nav class="nav" id="nav" aria-label="Principal">
    <div class="nav-in">
      <a class="brand" href="/" aria-label="${BRAND}, ir al inicio">${ISOLOGO}</a>
      <div class="nav-links">
        <a href="/#metodo">Método</a>
        <a href="/#sistemas">Sistemas</a>
        <a href="/#cotizadores">Cotizadores</a>
        <a href="/blog/" aria-current="true">Blog</a>
        <a href="/#preguntas">Preguntas</a>
      </div>
      <a class="btn sm" href="/#chat">Contanos tu obra</a>
    </div>
  </nav>
  <main id="contenido">
  ${content}
  </main>
  <footer class="footer">
    <div class="wrap">
      <div class="foot">
        <div class="foot-brand">
          <a class="brand" href="/" aria-label="${BRAND}, volver al inicio">${ISOLOGO}</a>
          <p>Constructora y desarrolladora de Neuquén. Construimos dos veces: primero en el modelo, después en el terreno.</p>
          <p>${BRAND} es una marca de BIMARG.</p>
        </div>
        <div>
          <span class="label">Zona</span>
          <p>Neuquén capital, Plottier, Centenario, Cipolletti, Fernández Oro, Cinco Saltos, Vista Alegre, Senillosa, Allen y hasta 50 km.</p>
        </div>
        <div>
          <span class="label">Contacto</span>
          <ul>
            <li><a href="${WHATSAPP}" target="_blank" rel="noopener">WhatsApp: +54 9 299 628-7652</a></li>
            <li><a href="https://app.bimarg.com" target="_blank" rel="noopener">Calculadora por rubros</a></li>
            <li><a href="/blog/">Blog</a></li>
          </ul>
        </div>
      </div>
      <div class="legal">
        <p>© ${new Date().getFullYear()} ${BRAND} · gemina.ar</p>
        <ul><li><a href="/legales#privacidad">Privacidad</a></li><li><a href="/legales#terminos">Términos</a></li></ul>
      </div>
    </div>
  </footer>
  <script src="/blog/main.js" defer></script>
</body>
</html>`;
}

function cardHtml(p) {
  return `
      <article class="post-card reveal" data-category="${esc(p.categoria)}">
        <a href="/blog/${p.slug}/" class="post-card-link">
          <div class="post-card-img">
            ${p.imagenLocal
              ? `<img src="${p.imagenLocal}" alt="${esc(p.titulo)}" loading="lazy" />`
              : `<div class="post-card-placeholder" aria-hidden="true"><svg viewBox="0 0 512 512"><use href="#isotipo"/></svg></div>`}
          </div>
          <div class="post-card-body">
            <span class="label"><b>${esc(p.categoria)}</b></span>
            <h2 class="post-card-title">${esc(p.titulo)}</h2>
            <p class="post-card-desc">${esc(p.descripcion)}</p>
            <div class="post-card-meta">
              <time datetime="${p.fechaRaw.slice(0, 10)}">${p.fecha}</time>
              <span>${esc(p.tiempoLectura)} de lectura</span>
            </div>
          </div>
        </a>
      </article>`;
}

function indexTemplate(posts) {
  const cards = posts.map(cardHtml).join("");

  const categorias = [...new Set(posts.map(p => p.categoria))];
  const filtros = categorias.map(c => `<button class="filter-btn" type="button" data-filter="${esc(c)}">${esc(c)}</button>`).join("");

  const description = "Cuánto cuesta construir una casa en Neuquén, qué casa entra en tu lote, sistemas constructivos y obra real. El blog de Gémina, constructora de Neuquén, Plottier y Cipolletti.";

  const content = `
  <header class="blog-hero">
    <div class="wrap">
      <span class="label"><b>Blog</b> · Neuquén capital y hasta 50 km</span>
      <h1>Antes de construir,<br><span>entendé tu obra.</span></h1>
      <p class="lead">Cuánto cuesta construir, qué casa entra en tu lote, con qué sistema conviene hacerla y cómo se controla una obra semana a semana. Lo que aprendimos construyendo dos veces: primero en el modelo, después en el terreno.</p>
    </div>
  </header>

  <section class="blog-list">
    <div class="wrap">
      ${categorias.length > 1 ? `<div class="blog-filters" role="group" aria-label="Filtrar por tema">
        <button class="filter-btn active" type="button" data-filter="all">Todos</button>
        ${filtros}
      </div>` : ""}
      <div class="posts-grid" id="postsGrid">
        ${cards}
      </div>
      ${posts.length === 0 ? '<p class="no-posts">Muy pronto, el primer artículo.</p>' : ""}
    </div>
  </section>
  ${ctaHtml()}`;

  const ld = jsonLd({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: `Blog de ${BRAND}`,
    url: `${SITE}/blog/`,
    description,
    inLanguage: "es-AR",
    publisher: ORG,
    blogPost: posts.slice(0, 20).map(p => ({
      "@type": "BlogPosting",
      headline: p.titulo,
      url: `${SITE}/blog/${p.slug}/`,
      datePublished: p.fechaRaw.slice(0, 10),
    })),
  });

  return htmlShell({
    title: "Blog · Construir una casa en Neuquén",
    description,
    canonical: "/blog/",
    content,
    extraHead: ld,
  });
}

function ctaHtml() {
  return `
  <section class="cta-band">
    <div class="wrap cta-in">
      <div>
        <span class="label"><b>¿Tenés terreno?</b></span>
        <h2>Contanos qué querés construir.</h2>
        <p class="lead">Te armamos un diagnóstico: qué casa entra en tu lote, con qué sistema y cuánto cuesta, rubro por rubro.</p>
      </div>
      <div class="cta-actions">
        <a class="btn" href="${WHATSAPP}" target="_blank" rel="noopener">Escribinos por WhatsApp ${ARROW}</a>
        <a class="btn sec" href="/#chat">Contanos tu obra</a>
      </div>
    </div>
  </section>`;
}

function relatedPostsHtml(currentPost, allPosts) {
  // Primero los de la misma categoría, después el resto (más recientes primero).
  const others = allPosts.filter(p => p.slug !== currentPost.slug);
  const same = others.filter(p => p.categoria === currentPost.categoria);
  const related = [...same, ...others.filter(p => p.categoria !== currentPost.categoria)].slice(0, 3);
  if (!related.length) return "";

  return `
    <section class="related-posts">
      <div class="wrap">
        <h2 class="related-title">Seguí leyendo</h2>
        <div class="posts-grid">
          ${related.map(cardHtml).join("")}
        </div>
      </div>
    </section>`;
}

function postTemplate(post, allPosts) {
  const url = `${SITE}/blog/${post.slug}/`;
  const ogImage = post.imagenLocal ? `${SITE}${post.imagenLocal}` : DEFAULT_OG;

  const content = `
  <article class="post-article">
    <header class="post-header">
      <div class="wrap post-narrow">
        <nav class="crumbs" aria-label="Ruta"><a href="/">Inicio</a><span>/</span><a href="/blog/">Blog</a><span>/</span><span>${esc(post.categoria)}</span></nav>
        <span class="label"><b>${esc(post.categoria)}</b></span>
        <h1 class="post-title">${esc(post.titulo)}</h1>
        ${post.descripcion ? `<p class="lead">${esc(post.descripcion)}</p>` : ""}
        <div class="post-meta">
          <span>${esc(post.autor)}</span>
          <span aria-hidden="true">·</span>
          <time datetime="${post.fechaRaw.slice(0, 10)}">${post.fecha}</time>
          ${post.actualizado ? `<span aria-hidden="true">·</span>
          <span>Actualizado el <time datetime="${post.editado.slice(0, 10)}">${post.actualizado}</time></span>` : ""}
          <span aria-hidden="true">·</span>
          <span>${esc(post.tiempoLectura)} de lectura</span>
        </div>
      </div>
    </header>
    ${post.imagenLocal ? `<div class="wrap"><figure class="post-cover"><img src="${post.imagenLocal}" alt="${esc(post.titulo)}" fetchpriority="high" /></figure></div>` : ""}
    <div class="wrap post-narrow">
      <div class="post-body">
        ${post.bodyHtml}
      </div>
      <a href="/blog/" class="post-back">← Todos los artículos</a>
    </div>
  </article>
  ${ctaHtml()}
  ${relatedPostsHtml(post, allPosts)}`;

  const ld = jsonLd([
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.titulo,
      description: post.descripcion,
      image: ogImage,
      datePublished: post.fechaRaw.slice(0, 10),
      dateModified: (post.editado || post.fechaRaw).slice(0, 10),
      author: post.autor === DEFAULT_AUTHOR
        ? ORG
        : { "@type": "Person", name: post.autor, worksFor: ORG },
      publisher: ORG,
      mainEntityOfPage: url,
      articleSection: post.categoria,
      inLanguage: "es-AR",
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: BRAND, item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog/` },
        { "@type": "ListItem", position: 3, name: post.titulo, item: url },
      ],
    },
  ]);

  return htmlShell({
    title: post.titulo,
    description: post.descripcion,
    canonical: `/blog/${post.slug}/`,
    content,
    ogImage,
    ogType: "article",
    extraHead: `<meta property="article:published_time" content="${post.fechaRaw.slice(0, 10)}" />\n  <meta property="article:section" content="${esc(post.categoria)}" />\n  ${ld}`,
  });
}

function rssXml(posts) {
  const items = posts.slice(0, 30).map(p => `
    <item>
      <title>${esc(p.titulo)}</title>
      <link>${SITE}/blog/${p.slug}/</link>
      <guid>${SITE}/blog/${p.slug}/</guid>
      <pubDate>${new Date(p.fechaRaw.length === 10 ? p.fechaRaw + "T12:00:00Z" : p.fechaRaw).toUTCString()}</pubDate>
      <category>${esc(p.categoria)}</category>
      <description>${esc(p.descripcion)}</description>
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Blog de ${BRAND}</title>
    <link>${SITE}/blog/</link>
    <description>Construir una casa en Neuquén: costos, lotes, sistemas constructivos y obra real.</description>
    <language>es-AR</language>${items}
  </channel>
</rss>
`;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.clarity.ms https://scripts.clarity.ms https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
  "font-src 'self' https://cdn.fontshare.com",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "frame-src https://www.youtube-nocookie.com",
  "connect-src 'self' https://*.clarity.ms https://cloudflareinsights.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const HEADERS = `/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: ${CSP}
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()

/blog/images/*
  Cache-Control: public, max-age=31536000, immutable

/blog/style.css
  Cache-Control: public, max-age=3600

/blog/main.js
  Cache-Control: public, max-age=3600
`;

// ─── Main ─────────────────────────────────────────────────────────────────

async function build() {
  console.log(`\n🚀 ${BRAND} Blog — Build iniciado\n`);
  const t0 = Date.now();

  ensureDir(DIST);
  ensureDir(BLOG_DIST);

  // Copiar assets (style.css, main.js)
  if (fs.existsSync(ASSETS)) {
    fs.cpSync(ASSETS, path.join(BLOG_DIST), { recursive: true });
  }

  console.log("📥 Leyendo posts desde Notion...");
  const posts = await fetchPosts();
  console.log(`   ${posts.length} post(s) publicado(s) encontrado(s)\n`);

  // Dos posts con el mismo slug se pisarían: cortar el build antes de publicar algo roto.
  const dup = posts.map(p => p.slug).filter((s, i, a) => a.indexOf(s) !== i);
  if (dup.length) throw new Error(`Slugs repetidos en Notion: ${[...new Set(dup)].join(", ")}`);

  // Links a posts del blog que todavía no salieron (Borrador o fecha futura): se publican como texto
  // común para no mandar a un 404. Cuando el post de destino se publica, la próxima corrida pone el link.
  const publicados = new Set(posts.map(p => p.slug));
  let linksOcultos = 0;
  const linkInterno = /<a href="(?:https:\/\/gemina\.ar)?\/blog\/([a-z0-9-]+)\/?"[^>]*>(.*?)<\/a>/g;
  for (const post of posts) {
    post.bodyHtml = post.bodyHtml.replace(linkInterno, (a, slug, texto) => {
      if (publicados.has(slug)) return a;
      linksOcultos++;
      return texto;
    });
  }
  if (linksOcultos) console.log(`   ${linksOcultos} link(s) a posts sin publicar quedaron como texto\n`);

  console.log("📄 Generando páginas...");
  writeFile(path.join(BLOG_DIST, "index.html"), indexTemplate(posts));

  for (const post of posts) {
    const postDir = path.join(BLOG_DIST, post.slug);
    writeFile(path.join(postDir, "index.html"), postTemplate(post, posts));
  }

  // Sitemap del blog: se regenera solo con los posts publicados.
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`  <url><loc>${SITE}/blog/</loc><lastmod>${today}</lastmod></url>`]
    .concat(posts.map(p => {
      const pub = p.fechaRaw.slice(0, 10), ed = (p.editado || "").slice(0, 10);
      return `  <url><loc>${SITE}/blog/${p.slug}/</loc><lastmod>${ed > pub ? ed : pub}</lastmod></url>`;
    }));
  writeFile(path.join(BLOG_DIST, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
  writeFile(path.join(BLOG_DIST, "feed.xml"), rssXml(posts));

  // Headers de seguridad de Cloudflare Pages: los mismos que manda la home de gemina.ar,
  // más YouTube (videos embebidos) e imágenes https (por si una imagen de Notion no se pudo bajar).
  writeFile(path.join(DIST, "_headers"), HEADERS);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Build completado en ${elapsed}s`);
  console.log(`   ${posts.length + 1} archivo(s) HTML generado(s)`);
  console.log(`   Salida: /dist/blog/\n`);
}

build().catch((err) => {
  console.error("\n❌ Error en el build:", err);
  process.exit(1);
});
