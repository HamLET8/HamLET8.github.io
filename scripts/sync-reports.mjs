#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "report-sources.local.json");
const fallbackConfigPath = path.join(repoRoot, "report-sources.example.json");
const configPath = process.env.REPORT_SOURCES_CONFIG
  ? path.resolve(process.env.REPORT_SOURCES_CONFIG)
  : defaultConfigPath;

const config = await readJson(await exists(configPath) ? configPath : fallbackConfigPath);
const generatedAt = new Date();
const reportsRoot = path.join(repoRoot, "reports");
const catalogPath = path.join(reportsRoot, "catalog.json");
const previousCatalog = await exists(catalogPath) ? await readJson(catalogPath) : null;

await fs.mkdir(path.join(reportsRoot, "assets"), { recursive: true });

const catalog = {
  siteTitle: config.siteTitle || "Reports",
  siteSubtitle: config.siteSubtitle || "",
  baseUrl: config.baseUrl || "",
  generatedAt: generatedAt.toISOString(),
  sections: []
};

for (const section of config.sections || []) {
  const outSection = {
    id: section.id,
    title: section.title,
    description: section.description || "",
    collections: []
  };

  for (const collection of section.collections || []) {
    const sourceRoot = path.resolve(collection.source);
    const destination = normalizeDestination(collection.destination);
    const destinationRoot = path.join(repoRoot, destination);

    await fs.rm(destinationRoot, { recursive: true, force: true });
    await fs.mkdir(destinationRoot, { recursive: true });

    for (const rule of collection.copy || [{ from: ".", to: "." }]) {
      const from = path.join(sourceRoot, rule.from || ".");
      const to = path.join(destinationRoot, rule.to || ".");
      await copyRule(from, to, rule, from);
    }

    const documents = await scanHtml(destinationRoot, destinationRoot);
    documents.sort(compareDocuments);

    const entry = collection.entry || "index.html";
    const collectionBase = destination.replace(/^reports\/?/, "").replace(/\/$/, "");
    const entryUrl = joinUrl(collectionBase, entry);

    outSection.collections.push({
      id: collection.id,
      title: collection.title,
      description: collection.description || "",
      tags: collection.tags || [],
      destination,
      entry,
      entryUrl,
      reportCount: documents.length,
      documents
    });
  }

  catalog.sections.push(outSection);
}

if (previousCatalog && sameCatalogContent(previousCatalog, catalog)) {
  catalog.generatedAt = previousCatalog.generatedAt;
}

await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

await fs.writeFile(path.join(reportsRoot, "index.html"), renderPortal(catalog), "utf8");

const sectionCount = catalog.sections.length;
const collectionCount = catalog.sections.reduce((sum, section) => sum + section.collections.length, 0);
const reportCount = catalog.sections.reduce(
  (sum, section) => sum + section.collections.reduce((inner, item) => inner + item.reportCount, 0),
  0
);

console.log(`Synced ${reportCount} HTML files across ${collectionCount} collections and ${sectionCount} sections.`);
console.log(`Portal: ${path.join(reportsRoot, "index.html")}`);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeDestination(destination) {
  if (!destination || path.isAbsolute(destination)) {
    throw new Error(`Destination must be relative and inside reports/: ${destination}`);
  }

  const normalized = destination.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith("reports/")) {
    throw new Error(`Destination must start with reports/: ${destination}`);
  }

  return normalized;
}

async function copyRule(from, to, rule, base) {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "_site" || entry.name === "node_modules") {
        continue;
      }
      await copyRule(path.join(from, entry.name), path.join(to, entry.name), rule, base);
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  const relative = path.relative(base, from).replace(/\\/g, "/");
  if (!matchesRule(from, relative, rule)) {
    return;
  }

  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  await fs.utimes(to, stat.atime, stat.mtime);
}

function matchesRule(filePath, relative, rule) {
  const fileName = path.basename(filePath);
  if (Array.isArray(rule.files) && rule.files.length > 0) {
    return rule.files.includes(relative) || rule.files.includes(fileName);
  }

  if (Array.isArray(rule.extensions) && rule.extensions.length > 0) {
    return rule.extensions.includes(path.extname(filePath).toLowerCase());
  }

  return true;
}

async function scanHtml(root, base) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const documents = [];

  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      documents.push(...await scanHtml(absolute, base));
      continue;
    }

    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".html") {
      continue;
    }

    const relativePath = path.relative(base, absolute).replace(/\\/g, "/");
    const html = await fs.readFile(absolute, "utf8");
    const stat = await fs.stat(absolute);
    documents.push({
      title: extractTitle(html) || relativePath,
      path: relativePath,
      href: relativePath,
      updatedAt: stat.mtime.toISOString()
    });
  }

  return documents;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return "";
  }

  return decodeHtml(match[1].replace(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function compareDocuments(a, b) {
  const aIndex = rankPath(a.path);
  const bIndex = rankPath(b.path);
  if (aIndex !== bIndex) {
    return aIndex - bIndex;
  }
  return a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true });
}

function rankPath(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name === "index.html") {
    return 0;
  }
  if (name.includes("plan")) {
    return 1;
  }
  return 10;
}

function joinUrl(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "");
}

function renderPortal(data) {
  const allCollections = data.sections.flatMap((section) =>
    section.collections.map((collection) => ({ section, collection }))
  );
  const allDocuments = allCollections
    .flatMap(({ section, collection }) =>
      collection.documents.map((document) => ({
        section,
        collection,
        document,
        href: joinUrl(collection.destination.replace(/^reports\/?/, ""), document.href)
      }))
    )
    .sort((a, b) => new Date(b.document.updatedAt) - new Date(a.document.updatedAt));

  const reportCount = allDocuments.length;
  const updated = formatDate(data.generatedAt);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.siteTitle)} · hamlet8.github.io</title>
  <meta name="description" content="${escapeHtml(data.siteSubtitle)}">
  <link rel="stylesheet" href="assets/portal.css">
</head>
<body>
  <div class="site-shell">
    <header class="topbar">
      <a class="brand" href="./" aria-label="报告阅读入口">
        <span class="brand-mark">R</span>
        <span>${escapeHtml(data.siteTitle)}</span>
      </a>
      <nav aria-label="主导航">
        <a href="/">博客首页</a>
        ${data.sections.map((section) => `<a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a>`).join("\n        ")}
        <a href="catalog.json">Catalog</a>
      </nav>
    </header>

    <section class="hero">
      <div class="hero-main">
        <p class="eyebrow">GitHub Pages</p>
        <h1>${escapeHtml(data.siteTitle)}</h1>
        <p>${escapeHtml(data.siteSubtitle)}</p>
      </div>
      <aside class="status-panel">
        <p class="status-label">远程入口</p>
        <p class="status-value">${escapeHtml(data.baseUrl || "https://hamlet8.github.io/reports/")}</p>
      </aside>
    </section>

    <section class="stat-grid" aria-label="目录状态">
      <div class="stat"><strong>${data.sections.length}</strong><span>一级分类</span></div>
      <div class="stat"><strong>${allCollections.length}</strong><span>报告集合</span></div>
      <div class="stat"><strong>${reportCount}</strong><span>HTML 页面</span></div>
      <div class="stat"><strong>${updated}</strong><span>最近同步</span></div>
    </section>

    <main class="content">
      <section class="section" aria-labelledby="recent-title">
        <div class="section-head">
          <div>
            <p class="eyebrow">Recent</p>
            <h2 id="recent-title">最近更新</h2>
          </div>
          <p>按本地文件更新时间排序，保留原报告页面的阅读体验。</p>
        </div>
        <div class="recent-list">
          ${allDocuments.slice(0, 6).map(({ section, collection, document, href }) => `
          <a class="recent" href="${escapeHtml(href)}">
            <small>${escapeHtml(section.title)} / ${escapeHtml(collection.title)}</small>
            <strong>${escapeHtml(document.title)}</strong>
          </a>`).join("")}
        </div>
      </section>

      ${data.sections.map(renderSection).join("\n")}
    </main>

    <footer class="footer">
      <span>Generated ${escapeHtml(data.generatedAt)} from local report sources.</span>
    </footer>
  </div>
</body>
</html>
`;
}

function renderSection(section) {
  return `<section class="section" id="${escapeHtml(section.id)}">
        <div class="section-head">
          <div>
            <p class="eyebrow">Section</p>
            <h2>${escapeHtml(section.title)}</h2>
          </div>
          <p>${escapeHtml(section.description || "")}</p>
        </div>
        <div class="collection-grid">
          ${section.collections.map(renderCollection).join("\n")}
        </div>
      </section>`;
}

function renderCollection(collection) {
  const destinationBase = collection.destination.replace(/^reports\/?/, "");
  return `<article class="collection">
            <h3>${escapeHtml(collection.title)}</h3>
            <p class="collection-desc">${escapeHtml(collection.description || "")}</p>
            <div class="tag-row">
              ${(collection.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
            <a class="entry-link" href="${escapeHtml(collection.entryUrl)}">进入集合</a>
            <div class="doc-list">
              ${collection.documents.map((document) => `
              <a class="doc-link" href="${escapeHtml(joinUrl(destinationBase, document.href))}">
                <strong>${escapeHtml(document.title)}</strong>
                <span>${escapeHtml(labelPath(document.path))}</span>
              </a>`).join("")}
            </div>
          </article>`;
}

function labelPath(filePath) {
  const base = path.basename(filePath, ".html");
  return base.replace(/[-_]/g, " ");
}

function formatDate(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sameCatalogContent(previous, next) {
  return JSON.stringify(catalogContent(previous)) === JSON.stringify(catalogContent(next));
}

function catalogContent(catalog) {
  return {
    siteTitle: catalog.siteTitle,
    siteSubtitle: catalog.siteSubtitle,
    baseUrl: catalog.baseUrl,
    sections: catalog.sections
  };
}
