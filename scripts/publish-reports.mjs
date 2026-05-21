#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

run(process.execPath, ["scripts/sync-reports.mjs"]);
await verifyLinks(path.join(repoRoot, "reports"));

const reportChanges = git(["status", "--porcelain", "--", "reports"]);
if (!reportChanges.trim()) {
  console.log("No report changes to publish.");
  process.exit(0);
}

const stagedOutsideReports = git(["diff", "--cached", "--name-only"])
  .split("\n")
  .filter(Boolean)
  .filter((file) => !file.startsWith("reports/"));

if (stagedOutsideReports.length > 0) {
  throw new Error(
    `Refusing to publish while unrelated staged files exist:\n${stagedOutsideReports.join("\n")}`
  );
}

console.log(reportChanges.trim());

if (dryRun) {
  console.log("Dry run only; reports were synced and verified, but not committed or pushed.");
  process.exit(0);
}

run("git", ["add", "reports"]);
run("git", ["commit", "-m", `Update reports ${formatShanghaiTime(new Date())}`]);
run("git", ["push"]);

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit"
  });
}

async function verifyLinks(root) {
  const htmlFiles = await listHtml(root);
  const missing = [];
  const idCache = new Map();

  for (const file of htmlFiles) {
    const html = await fs.readFile(file, "utf8");

    for (const match of html.matchAll(/(?:href|src)=['"]([^'"]+)['"]/g)) {
      const raw = match[1];
      if (raw.startsWith("#") || /^(https?:|mailto:|tel:|data:|javascript:)/i.test(raw)) {
        continue;
      }

      const target = raw.split("#")[0].split("?")[0];
      if (!target) {
        continue;
      }

      const absolute = target.startsWith("/")
        ? path.join(repoRoot, target.replace(/^\/+/, ""))
        : path.resolve(path.dirname(file), target);

      if (!await exists(absolute)) {
        missing.push(`${path.relative(repoRoot, file)} -> ${raw}`);
      }
    }

    for (const match of html.matchAll(/href=['"]([^'"]*#[^'"]+)['"]/g)) {
      const raw = match[1];
      if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(raw)) {
        continue;
      }

      const [targetPart, hashPart] = raw.split("#");
      if (!hashPart) {
        continue;
      }

      const target = targetPart
        ? targetPart.split("?")[0].startsWith("/")
          ? path.join(repoRoot, targetPart.split("?")[0].replace(/^\/+/, ""))
          : path.resolve(path.dirname(file), targetPart.split("?")[0])
        : file;

      if (await exists(target) && !await hasAnchor(target, decodeURIComponent(hashPart), idCache)) {
        missing.push(`${path.relative(repoRoot, file)} -> ${raw}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing local report links:\n${missing.join("\n")}`);
  }

  console.log(`Verified ${htmlFiles.length} report HTML files.`);
}

async function listHtml(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listHtml(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(absolute);
    }
  }

  return files;
}

async function hasAnchor(file, anchor, cache) {
  if (!cache.has(file)) {
    const html = await fs.readFile(file, "utf8");
    const ids = new Set();
    for (const match of html.matchAll(/\s(?:id|name)=['"]([^'"]+)['"]/g)) {
      ids.add(match[1]);
    }
    cache.set(file, ids);
  }

  return cache.get(file).has(anchor);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatShanghaiTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} CST`;
}
