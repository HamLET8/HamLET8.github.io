const TRACK_STORAGE_KEY = "storage-radar-tracked-patches";
const TRACK_PASSWORD = "4506";

const state = {
  data: null,
  reports: [],
  moduleId: "ufs",
  query: "",
  risk: "all",
  theme: localStorage.getItem("storage-radar-theme") || "dark",
  tracked: loadTrackedTargets(),
};

const els = {
  workspace: document.querySelector(".workspace"),
  snapshotAge: document.querySelector("#snapshot-age"),
  moduleNav: document.querySelector("#module-nav"),
  sourceList: document.querySelector("#source-list"),
  moduleTitle: document.querySelector("#module-title"),
  metricsGrid: document.querySelector("#metrics-grid"),
  insightPanel: document.querySelector("#insight-panel"),
  insightSummary: document.querySelector("#insight-summary"),
  dailySummary: document.querySelector("#daily-summary"),
  watchList: document.querySelector("#watch-list"),
  trackingPanel: document.querySelector("#tracking-panel"),
  reportsPanel: document.querySelector("#reports-panel"),
  todayQueue: document.querySelector("#today-queue"),
  reviewList: document.querySelector("#review-list"),
  bugList: document.querySelector("#bug-list"),
  fixList: document.querySelector("#fix-list"),
  themeList: document.querySelector("#theme-list"),
  searchInput: document.querySelector("#search-input"),
  riskFilter: document.querySelector("#risk-filter"),
  themeToggle: document.querySelector("#theme-toggle"),
  refreshView: document.querySelector("#refresh-view"),
  emptyTemplate: document.querySelector("#empty-template"),
};

const PERFORMANCE_VIEW_ID = "performance";
const priorityOrder = ["must-read", "watch", "reference", "skip"];
const priorityLabels = {
  "must-read": "Must read",
  watch: "Watch",
  reference: "Reference",
  skip: "Skip",
};
const reasonLabels = {
  "ufs-direct": "UFS direct",
  "block-path": "Block path",
  "scsi-path": "SCSI path",
  "fs-writeback": "FS/writeback",
  "mm-path": "MM path",
  "perf-reference": "Reference",
  "bug-risk": "Bug risk",
  "review-action": "Review action",
  "style-only": "Style only",
  unrelated: "Unrelated",
};
const genericInsightPattern = /\b(general|misc|other|uncategorized-risk|needs-triage)\b|未分类风险/i;
const performanceFocus = {
  id: PERFORMANCE_VIEW_ID,
  label: "Performance Focus",
  paths: ["UFS", "block", "SCSI", "NVMe", "F2FS", "MM/writeback", "io_uring"],
  terms: [
    "performance",
    "latency",
    "throughput",
    "iops",
    "blk-mq",
    "polling",
    "queue depth",
    "completion",
    "interrupt",
    "flush",
    "fsync",
    "writeback",
    "discard",
    "runtime pm",
    "clock scaling",
    "mcq",
    "hpb",
  ],
  tags: ["performance", "latency", "throughput", "queueing", "completion", "writeback", "flush", "discard", "power-management"],
  modules: ["ufs", "block", "scsi", "nvme", "f2fs", "mm", "io_uring"],
  guides: [
    { id: "device-path", label: "UFS device path", modules: ["ufs"], terms: ["ufs", "ufshcd", "mcq", "hpb", "clock", "hibern8", "uic"], why: "MCQ、HPB、clock scaling、runtime PM、error recovery 对端到端延迟最直接。" },
    { id: "block-path", label: "Block core", modules: ["block"], terms: ["blk-mq", "polling", "merge", "rq_qos", "completion", "queue depth"], why: "blk-mq、polling、merge、flush、rq_qos 决定 I/O 栈的队列行为。" },
    { id: "scsi-path", label: "SCSI mid-layer", modules: ["scsi"], terms: ["scsi", "tag", "timeout", "error handler"], why: "UFS 仍经过 SCSI，timeout、tag、EH 路径会反向影响性能稳定性。" },
    { id: "fs-writeback", label: "FS / writeback", modules: ["f2fs"], terms: ["f2fs", "fsync", "checkpoint", "discard", "writeback", "gc"], why: "真实移动端负载常受 fsync、checkpoint、discard、GC 和 writeback 影响。" },
    { id: "mm-path", label: "MM / page cache", modules: ["mm"], terms: ["dirty", "folio", "readahead", "page cache", "writeback"], why: "dirty throttling、folio、readahead、page cache 常是吞吐和尾延迟根因。" },
    { id: "reference-path", label: "Reference path", modules: ["nvme", "io_uring"], terms: ["nvme", "io_uring", "polling", "completion", "multipath"], why: "NVMe 和 io_uring 的 polling、completion、multipath 讨论可作为 UFS 优化参照。" },
  ],
};

async function boot() {
  applyThemeChoice(state.theme);
  const [snapshot, reports] = await Promise.all([loadSnapshot(), loadReports()]);
  state.data = snapshot;
  state.reports = reports;
  state.moduleId = state.data.defaultModule || "ufs";
  wireEvents();
  render();
}

async function loadSnapshot() {
  try {
    const response = await fetch("./data/snapshot.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`snapshot ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn("Using embedded fallback data", error);
    return fallbackSnapshot;
  }
}

async function loadReports() {
  try {
    const response = await fetch("./reports/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`reports ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload.reports) ? payload.reports : [];
  } catch (error) {
    console.warn("Using empty report list", error);
    return [];
  }
}

function wireEvents() {
  els.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderContent();
  });

  els.riskFilter.addEventListener("change", (event) => {
    state.risk = event.target.value;
    renderContent();
  });

  els.refreshView.addEventListener("click", () => renderContent());

  els.workspace.addEventListener("click", (event) => {
    const button = event.target.closest("[data-track-action]");
    if (!button) return;
    event.preventDefault();
    const item = findItemById(button.dataset.trackId);
    if (button.dataset.trackAction === "track" && item) trackItem(item);
    if (button.dataset.trackAction === "untrack") untrackTarget(button.dataset.trackKey);
  });

  els.themeToggle.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-theme-choice]");
    if (!button) return;
    state.theme = button.dataset.themeChoice;
    localStorage.setItem("storage-radar-theme", state.theme);
    applyThemeChoice(state.theme);
    renderThemeToggle();
  });

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.theme === "system") applyThemeChoice("system");
    });
  }
}

function render() {
  renderShell();
  renderContent();
}

function renderShell() {
  const generated = new Date(state.data.generatedAt);
  const insightsGenerated = state.data.insights?.generatedAt ? new Date(state.data.insights.generatedAt) : null;
  els.snapshotAge.innerHTML = `
    <span>Updated ${escapeHtml(formatRelative(generated))}</span>
    <span>Data ${escapeHtml(formatDateTime(generated))}</span>
    ${insightsGenerated ? `<span>AI ${escapeHtml(formatDateTime(insightsGenerated))}</span>` : ""}
    <span>Daily 04:20 CST</span>
  `;
  renderThemeToggle();
  const navItems = [performanceFocus, ...state.data.modules];
  const moduleButtons = navItems.map((module) => renderModuleButton(module));
  els.moduleNav.innerHTML = [
    moduleButtons[0],
    renderReportsNavLink(),
    ...moduleButtons.slice(1),
  ].join("");

  els.moduleNav.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.moduleId = button.dataset.module;
      renderShell();
      renderContent();
    });
  });

  els.sourceList.innerHTML = state.data.sources.map((source) => `
    <a class="source-pill" href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">
      <span>${escapeHtml(source.name)}</span>
      <span>${escapeHtml(source.kind)}</span>
    </a>
  `).join("");
}

function renderModuleButton(module) {
  const count = countModuleItems(module.id);
  return `
    <button class="module-button ${module.id === PERFORMANCE_VIEW_ID ? "focus-button" : ""} ${module.id === state.moduleId ? "active" : ""}" data-module="${module.id}">
      <span>
        <strong>${escapeHtml(module.label)}</strong>
        <span>${escapeHtml(module.paths.join(", "))}</span>
      </span>
      <span class="module-count">${count}</span>
    </button>
  `;
}

function renderReportsNavLink() {
  const count = state.reports?.length || 0;
  return `
    <a class="module-button report-button" href="./reports/index.html">
      <span>
        <strong>Reading Reports</strong>
        <span>GPT technical deep dives</span>
      </span>
      <span class="module-count">${count}</span>
    </a>
  `;
}

function renderThemeToggle() {
  els.themeToggle.querySelectorAll("button[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === state.theme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function applyThemeChoice(choice) {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = choice;
}

function resolveTheme(choice) {
  if (choice === "light" || choice === "dark") return choice;
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function renderContent() {
  const module = getModule();
  const isPerformance = isPerformanceView();
  els.moduleTitle.textContent = module.label;

  const reviews = filterItems(state.data.reviews);
  const bugs = filterItems(state.data.bugs);
  const fixes = filterItems(state.data.fixes);
  const themes = buildThemes([...reviews, ...bugs, ...fixes]);
  const moduleInsights = isPerformance
    ? buildPerformanceInsights([...reviews, ...bugs, ...fixes], themes)
    : state.data.insights?.modules?.[state.moduleId] || null;

  renderMetrics(module, reviews, bugs, fixes, themes);
  renderInsights(moduleInsights, { module, items: [...reviews, ...bugs, ...fixes], themes, isPerformance });
  renderTrackingPanel();
  renderReportsPanel();
  renderTodayQueue([...reviews, ...bugs, ...fixes]);
  renderCards(els.reviewList, reviews, renderReviewCard);
  renderCards(els.bugList, bugs, renderBugCard);
  renderCards(els.fixList, fixes, renderFixCard);
  if (isPerformance) renderPerformanceFocusMap([...reviews, ...bugs, ...fixes], themes);
  else if (moduleInsights?.clusters?.length) renderInsightClusters(moduleInsights.clusters);
  else renderThemes(themes);
}

function getModule() {
  if (isPerformanceView()) return performanceFocus;
  return state.data.modules.find((module) => module.id === state.moduleId) || state.data.modules[0];
}

function countModuleItems(moduleId) {
  if (moduleId === PERFORMANCE_VIEW_ID) {
    return ["reviews", "bugs", "fixes"].reduce((total, key) => total + state.data[key].filter(performanceMatches).length, 0);
  }
  return ["reviews", "bugs", "fixes"].reduce((total, key) => {
    return total + state.data[key].filter((item) => item.module === moduleId).length;
  }, 0);
}

function filterItems(items) {
  return items
    .filter((item) => isPerformanceView() ? performanceMatches(item) : item.module === state.moduleId)
    .filter((item) => riskMatches(item))
    .filter((item) => queryMatches(item))
    .sort((a, b) => {
      if (isPerformanceView()) {
        const scoreDelta = performanceScore(b) - performanceScore(a);
        if (scoreDelta) return scoreDelta;
      }
      return new Date(b.date || b.updatedAt) - new Date(a.date || a.updatedAt);
    });
}

function riskMatches(item) {
  if (state.risk === "all") return true;
  return (item.riskTags || []).includes(state.risk);
}

function queryMatches(item) {
  if (!state.query) return true;
  const haystack = [
    item.title,
    item.summary,
    item.analysis?.main,
    item.analysis?.impact,
    item.analysis?.relevance,
    item.analysis?.readingHint,
    item.status,
    item.submitter,
    item.reviewer,
    item.component,
    moduleLabel(item.module),
    ...(item.riskTags || []),
    ...(item.signals || []),
    ...(item.files || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(state.query);
}

function renderMetrics(module, reviews, bugs, fixes, themes) {
  if (isPerformanceView()) {
    renderPerformanceMetrics(reviews, bugs, fixes);
    return;
  }
  const highRisk = [...reviews, ...bugs].filter((item) => (item.riskTags || []).some((tag) => ["critical", "race", "locking", "timeout", "reset"].includes(tag))).length;
  const metrics = [
    { label: "active reviews", value: reviews.length, trend: module.trend?.reviews || [] },
    { label: "open bugs", value: bugs.filter((bug) => !isResolved(bug.status)).length, trend: module.trend?.bugs || [] },
    { label: "merged fixes", value: fixes.length, trend: module.trend?.fixes || [] },
    { label: "high-risk signals", value: highRisk, trend: themes.slice(0, 7).map((theme) => theme.count) },
  ];

  els.metricsGrid.innerHTML = metrics.map((metric) => `
    <article class="metric">
      <strong>${metric.value}</strong>
      <span>${metric.label}</span>
      ${renderSparkline(metric.trend)}
    </article>
  `).join("");
}

function renderPerformanceMetrics(reviews, bugs, fixes) {
  const items = [...reviews, ...bugs, ...fixes];
  const latencyItems = items.filter((item) => hasPerformanceSignal(item, ["latency", "queueing", "completion", "performance"])).length;
  const writebackItems = items.filter((item) => hasPerformanceSignal(item, ["writeback", "flush", "discard"])).length;
  const ufsAdjacent = items.filter((item) => ["ufs", "block", "scsi"].includes(item.module)).length;
  const metrics = [
    { label: "performance items", value: items.length, trend: buildPerformanceTrend(items) },
    { label: "active reviews", value: reviews.length, trend: buildPerformanceTrend(reviews) },
    { label: "latency / queueing", value: latencyItems, trend: buildPerformanceTrend(items.filter((item) => hasPerformanceSignal(item, ["latency", "queueing", "completion", "performance"]))) },
    { label: "UFS-adjacent path", value: ufsAdjacent, trend: buildPerformanceTrend(items.filter((item) => ["ufs", "block", "scsi"].includes(item.module))) },
  ];

  if (writebackItems > 0) {
    metrics[3] = { label: "writeback / flush", value: writebackItems, trend: buildPerformanceTrend(items.filter((item) => hasPerformanceSignal(item, ["writeback", "flush", "discard"]))) };
  }

  els.metricsGrid.innerHTML = metrics.map((metric) => `
    <article class="metric">
      <strong>${metric.value}</strong>
      <span>${metric.label}</span>
      ${renderSparkline(metric.trend)}
    </article>
  `).join("");
}

function renderSparkline(values) {
  const normalized = values.length ? values : [1, 2, 1, 3, 2, 4, 3];
  const max = Math.max(...normalized, 1);
  return `
    <div class="sparkline" aria-hidden="true">
      ${normalized.slice(-7).map((value) => `<i style="height:${Math.max(4, Math.round((value / max) * 26))}px"></i>`).join("")}
    </div>
  `;
}

function renderCards(container, items, renderer) {
  if (!items.length) {
    container.innerHTML = "";
    container.appendChild(els.emptyTemplate.content.cloneNode(true));
    return;
  }

  container.innerHTML = items.map(renderer).join("");
}

function renderReviewCard(item) {
  return `
    <article class="item-card">
      <header>
        <h4 class="item-title"><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h4>
        <div class="card-actions">
          ${trackingButton(item)}
          ${stateBadge(item.status)}
        </div>
      </header>
      <div class="meta-row">
        ${isPerformanceView() ? meta(moduleLabel(item.module)) : ""}
        ${priorityBadge(item)}
        ${reasonBadge(item)}
        ${meta(item.submitter)}
        ${meta(`v${item.version || 1}`)}
        ${meta(formatDate(item.date))}
        ${item.series ? meta(item.series) : ""}
      </div>
      ${tagRow(item)}
      ${analysisBlock(item)}
      <p class="review-note">${escapeHtml(item.summary || "等待 review 信号。")}</p>
    </article>
  `;
}

function renderBugCard(item) {
  return `
    <article class="item-card">
      <header>
        <h4 class="item-title"><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h4>
        <div class="card-actions">
          ${trackingButton(item)}
          ${stateBadge(item.status)}
        </div>
      </header>
      <div class="meta-row">
        ${isPerformanceView() ? meta(moduleLabel(item.module)) : ""}
        ${priorityBadge(item)}
        ${reasonBadge(item)}
        ${meta(item.component)}
        ${meta(formatDate(item.updatedAt || item.date))}
      </div>
      ${tagRow(item)}
      ${analysisBlock(item)}
      ${item.summary ? `<p class="review-note">${escapeHtml(item.summary)}</p>` : ""}
    </article>
  `;
}

function renderFixCard(item) {
  return `
    <article class="item-card">
      <header>
        <h4 class="item-title"><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h4>
        <div class="card-actions">
          ${trackingButton(item)}
          ${stateBadge(item.status)}
        </div>
      </header>
      <div class="meta-row">
        ${isPerformanceView() ? meta(moduleLabel(item.module)) : ""}
        ${priorityBadge(item)}
        ${reasonBadge(item)}
        ${meta(item.submitter || item.component)}
        ${meta(formatDate(item.date || item.updatedAt))}
      </div>
      ${tagRow(item)}
      ${analysisBlock(item)}
    </article>
  `;
}

function analysisBlock(item) {
  if (!item.analysis) return "";
  const rows = [
    ["主要内容", item.analysis.main],
    ["影响", item.analysis.impact],
    ["相关性", item.analysis.relevance],
    ["阅读建议", item.analysis.readingHint],
  ].filter(([, value]) => value);
  if (!rows.length) return "";
  return `
    <div class="decision-strip">
      <strong>${escapeHtml(priorityLabels[itemPriority(item)] || "Reference")}</strong>
      <span>${escapeHtml(decisionText(item))}</span>
    </div>
    ${evidenceRow(item)}
    <details class="item-analysis">
      <summary>AI details</summary>
      ${rows.map(([label, value]) => `
        <p><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></p>
      `).join("")}
    </details>
  `;
}

function renderTrackingPanel() {
  if (!els.trackingPanel) return;
  const tracked = state.tracked || [];
  const matches = tracked.map((target) => ({
    target,
    match: matchTrackedTarget(target),
  }));

  els.trackingPanel.innerHTML = `
    <div class="tracking-head">
      <div>
        <p class="eyebrow">Tracking Window</p>
        <h3>Tracked Patches</h3>
      </div>
      <span>${tracked.length} tracked</span>
    </div>
    <div class="tracking-list">
      ${matches.length ? matches.map(renderTrackedItem).join("") : `
        <div class="tracking-empty">
          <strong>No tracked patches</strong>
          <span>Waiting for pinned patch records.</span>
        </div>
      `}
    </div>
  `;
}

function renderReportsPanel() {
  if (!els.reportsPanel) return;
  const reports = state.reports || [];
  const latest = reports.slice(0, 4);
  els.reportsPanel.innerHTML = `
    <div class="reports-head">
      <div>
        <p class="eyebrow">Reading Reports</p>
        <h3>Scheduled Deep Dives</h3>
      </div>
      <a class="report-index-link" href="./reports/index.html">All reports</a>
    </div>
    <div class="report-list">
      ${latest.length ? latest.map(renderReportLink).join("") : `
        <div class="report-empty">
          <strong>No reports yet</strong>
          <span>Reports are generated every Tue / Thu / Sat after data refresh.</span>
        </div>
      `}
    </div>
  `;
}

function renderReportLink(report) {
  const count = Array.isArray(report.items) ? report.items.length : Number(report.itemCount || 0);
  return `
    <a class="report-link" href="${escapeAttr(report.path || "./reports/index.html")}">
      <div>
        <div class="report-meta">
          <span>${escapeHtml(formatDate(report.generatedAt || report.date))}</span>
          <span>${escapeHtml(count ? `${count} items` : "report")}</span>
          ${report.model ? `<span>${escapeHtml(report.model)}</span>` : ""}
        </div>
        <strong>${escapeHtml(report.title || "Storage reading report")}</strong>
        <p>${escapeHtml(report.summary || "精选近期值得阅读的 patch 和 bug。")}</p>
      </div>
      <span aria-hidden="true">→</span>
    </a>
  `;
}

function renderTrackedItem({ target, match }) {
  const item = match?.item;
  const status = item ? trackingStatus(target, item) : "missing";
  const title = item?.title || target.title || "Unknown patch";
  const summary = item?.analysis?.main || item?.summary || target.series || "当前快照中未找到匹配项。";
  return `
    <article class="tracked-item status-${escapeAttr(status)}">
      <div class="tracked-main">
        <div class="tracked-meta">
          <span>${escapeHtml(item ? moduleLabel(item.module) : target.moduleLabel || target.module || "unknown")}</span>
          <span>${escapeHtml(statusLabel(status))}</span>
          ${item ? `<span>${escapeHtml(item.status || "unknown")}</span>` : ""}
          ${item?.version ? `<span>v${escapeHtml(item.version)}</span>` : ""}
        </div>
        <a class="tracked-title" href="${escapeAttr(item?.url || target.url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="tracked-actions">
        ${item ? priorityBadge(item) : `<span class="badge">missing</span>`}
        <button type="button" class="track-button danger" data-track-action="untrack" data-track-key="${escapeAttr(target.key)}">Untrack</button>
      </div>
    </article>
  `;
}

function trackingButton(item) {
  const target = matchingStoredTarget(item);
  if (target) {
    return `<button type="button" class="track-button active" data-track-action="untrack" data-track-key="${escapeAttr(target.key)}">Tracked</button>`;
  }
  return `<button type="button" class="track-button" data-track-action="track" data-track-id="${escapeAttr(item.id)}">Track</button>`;
}

function trackItem(item) {
  if (!requireTrackingPassword()) return;
  const target = buildTrackTarget(item);
  const existingIndex = state.tracked.findIndex((entry) => entry.key === target.key || entry.id === item.id);
  if (existingIndex >= 0) state.tracked[existingIndex] = { ...state.tracked[existingIndex], ...target };
  else state.tracked.unshift(target);
  saveTrackedTargets();
  renderContent();
}

function untrackTarget(key) {
  if (!key || !requireTrackingPassword()) return;
  state.tracked = state.tracked.filter((entry) => entry.key !== key);
  saveTrackedTargets();
  renderContent();
}

function requireTrackingPassword() {
  const value = window.prompt("输入追踪密码");
  if (value === TRACK_PASSWORD) return true;
  if (value !== null) window.alert("密码错误");
  return false;
}

function buildTrackTarget(item) {
  return {
    key: trackingKey(item),
    id: item.id,
    title: item.title,
    titleKey: normalizeTrackingText(item.title),
    series: item.series || "",
    seriesKey: normalizeTrackingText(item.series || ""),
    module: item.module,
    moduleLabel: moduleLabel(item.module),
    url: item.url,
    version: Number(item.version || 0),
    date: item.date || item.updatedAt || "",
    trackedAt: new Date().toISOString(),
  };
}

function matchingStoredTarget(item) {
  const key = trackingKey(item);
  const titleKey = normalizeTrackingText(item.title);
  return state.tracked.find((target) => (
    target.key === key
    || target.id === item.id
    || (target.titleKey && target.titleKey === titleKey)
  ));
}

function matchTrackedTarget(target) {
  const candidates = allItems()
    .map((item) => ({ item, score: trackingMatchScore(target, item), date: new Date(item.updatedAt || item.date || 0) }))
    .filter((entry) => entry.score >= 45)
    .sort((a, b) => {
      const newerDelta = Number(isTrackedUpdate(target, b.item)) - Number(isTrackedUpdate(target, a.item));
      if (newerDelta) return newerDelta;
      const dateDelta = b.date - a.date;
      if (dateDelta) return dateDelta;
      return b.score - a.score;
    });
  return candidates[0] || null;
}

function trackingMatchScore(target, item) {
  let score = 0;
  const titleKey = normalizeTrackingText(item.title);
  const seriesKey = normalizeTrackingText(item.series || "");
  if (target.id && target.id === item.id) score += 55;
  if (target.url && target.url === item.url) score += 45;
  if (target.titleKey && target.titleKey === titleKey) score += 70;
  if (target.seriesKey && target.seriesKey === seriesKey) score += 54;
  if (target.module && target.module === item.module) score += 8;
  return score;
}

function trackingStatus(target, item) {
  if (isTrackedUpdate(target, item)) return "updated";
  if (item.id === target.id) return "current";
  return "matched";
}

function isTrackedUpdate(target, item) {
  const targetVersion = Number(target.version || 0);
  const itemVersion = Number(item.version || 0);
  const itemTime = new Date(item.updatedAt || item.date || 0).getTime();
  const targetTime = new Date(target.date || target.trackedAt || 0).getTime();
  if (itemVersion && targetVersion && itemVersion > targetVersion) return true;
  return item.id !== target.id && itemTime > targetTime;
}

function statusLabel(status) {
  const labels = {
    updated: "updated",
    current: "current",
    matched: "matched",
    missing: "missing",
  };
  return labels[status] || status;
}

function loadTrackedTargets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRACK_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      ...entry,
      key: entry.key || trackingKey(entry),
      titleKey: entry.titleKey || normalizeTrackingText(entry.title),
      seriesKey: entry.seriesKey || normalizeTrackingText(entry.series || ""),
    })).filter((entry) => entry.key && entry.title);
  } catch {
    return [];
  }
}

function saveTrackedTargets() {
  localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(state.tracked.slice(0, 80)));
}

function trackingKey(item) {
  return `${normalizeTrackingText(item.series || "") || normalizeTrackingText(item.title || "")}::${item.module || ""}`.slice(0, 180);
}

function normalizeTrackingText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\[[^\]]*\b(?:patch|rfc|resend|next|v\d+|\d+\/\d+)[^\]]*\]/gi, " ")
    .replace(/\b(?:patch|rfc|resend|v\d+)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9_+./ -]+/g, "")
    .trim();
}

function renderTodayQueue(items) {
  if (!els.todayQueue) return;
  const buckets = priorityOrder.map((priority) => {
    const bucket = items
      .filter((item) => itemPriority(item) === priority)
      .sort((a, b) => itemDecisionScore(b) - itemDecisionScore(a) || new Date(b.date || b.updatedAt) - new Date(a.date || a.updatedAt));
    return { priority, items: bucket };
  });
  const visible = buckets.filter((bucket) => bucket.items.length);
  if (!visible.length) {
    els.todayQueue.hidden = true;
    els.todayQueue.innerHTML = "";
    return;
  }
  els.todayQueue.hidden = false;
  els.todayQueue.innerHTML = `
    <div class="queue-head">
      <div>
        <p class="eyebrow">Reading decision</p>
        <h3>Today Queue</h3>
      </div>
      <span>${items.length} filtered items</span>
    </div>
    <div class="queue-grid">
      ${visible.map((bucket) => renderQueueColumn(bucket)).join("")}
    </div>
  `;
}

function renderQueueColumn(bucket) {
  const limit = bucket.priority === "skip" ? 3 : 5;
  return `
    <article class="queue-column priority-${escapeAttr(bucket.priority)}">
      <header>
        <strong>${escapeHtml(priorityLabels[bucket.priority] || bucket.priority)}</strong>
        <span>${bucket.items.length}</span>
      </header>
      <div>
        ${bucket.items.slice(0, limit).map((item) => `
          <a class="queue-item" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">
            <span>${escapeHtml(moduleLabel(item.module))} · ${escapeHtml(reasonLabels[itemReason(item)] || itemReason(item))}</span>
            <strong>${escapeHtml(item.title)}</strong>
          </a>
        `).join("")}
      </div>
    </article>
  `;
}

function renderThemes(themes) {
  if (!themes.length) {
    els.themeList.innerHTML = "";
    els.themeList.appendChild(els.emptyTemplate.content.cloneNode(true));
    return;
  }

  const max = Math.max(...themes.map((theme) => theme.count), 1);
  els.themeList.innerHTML = themes.slice(0, 10).map((theme) => `
    <div class="theme-row">
      <strong>${escapeHtml(theme.label)}</strong>
      <span class="theme-bar"><span style="width:${Math.max(8, Math.round((theme.count / max) * 100))}%"></span></span>
      <span>${theme.count}</span>
    </div>
  `).join("");
}

function renderInsightClusters(clusters) {
  const safeClusters = safeInsightClusters(clusters);
  if (!safeClusters.length) {
    els.themeList.innerHTML = "";
    els.themeList.appendChild(els.emptyTemplate.content.cloneNode(true));
    return;
  }
  els.themeList.innerHTML = safeClusters.slice(0, 10).map((cluster) => `
    <article class="cluster-row">
      <div>
        <strong>${escapeHtml(cluster.label)}</strong>
        <span>${escapeHtml(cluster.whyItMatters || "模型认为这个方向值得关注。")}</span>
      </div>
      <span class="cluster-count">${Number(cluster.count || 0)}</span>
    </article>
  `).join("");
}

function renderPerformanceFocusMap(items, themes) {
  const maxCount = Math.max(...performanceFocus.guides.map((guide) => performanceTaxonomyItems(items, guide).length), 1);
  const focusRows = performanceFocus.guides.map((guide) => {
    const count = performanceTaxonomyItems(items, guide).length;
    return `
      <article class="focus-card">
        <div>
          <strong>${escapeHtml(guide.label)}</strong>
          <span>${escapeHtml(guide.why)}</span>
        </div>
        <div class="focus-score">
          <span>${count}</span>
          <i style="width:${Math.max(8, Math.round((count / maxCount) * 100))}%"></i>
        </div>
      </article>
    `;
  }).join("");

  const termRows = themes
    .filter((theme) => performanceFocus.tags.includes(theme.label) || performanceFocus.terms.includes(theme.label))
    .slice(0, 8);

  els.themeList.innerHTML = `
    <div class="focus-map">${focusRows}</div>
    ${termRows.length ? `
      <div class="focus-terms">
        ${termRows.map((theme) => `<span>${escapeHtml(theme.label)} · ${theme.count}</span>`).join("")}
      </div>
    ` : ""}
  `;
}

function renderInsights(moduleInsights, context = {}) {
  if (!moduleInsights) {
    els.insightPanel.hidden = true;
    return;
  }

  els.insightPanel.hidden = false;
  els.insightSummary.textContent = cleanInsightText(moduleInsights.summary, "AI 摘要正在重新生成。");
  els.dailySummary.textContent = buildInsightDetail(moduleInsights, context);

  const refs = [
    ...(moduleInsights.watchlist || []).map((item) => ({ ...item, kind: "watch" })),
    ...(moduleInsights.interestMatches || []).map((item) => ({ ...item, kind: "interest" })),
  ];
  const seen = new Set();
  const cards = refs
    .map((ref) => ({ ref, item: findItemById(ref.itemId) }))
    .filter(({ item }) => item && !seen.has(item.id) && seen.add(item.id))
    .slice(0, 6);

  if (!cards.length) {
    els.watchList.innerHTML = `<span class="insight-muted">暂无重点关注条目</span>`;
    return;
  }

  els.watchList.innerHTML = cards.map(({ ref, item }) => `
    <a class="watch-item" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">
      <span class="badge">${escapeHtml(ref.kind === "interest" ? "interest" : "watch")}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(ref.reason || "建议打开原始链接确认上下文。")}</span>
    </a>
  `).join("");
}

function buildInsightDetail(moduleInsights, { items = [], themes = [], isPerformance = false } = {}) {
  if (isPerformance) {
    return cleanInsightText(moduleInsights.dailySummary, "按性能路径分流，优先查看 latency、queueing、flush/writeback 和恢复路径。");
  }

  const clusters = safeInsightClusters(moduleInsights.clusters).slice(0, 3);
  const clusterText = clusters.length
    ? `主题 ${clusters.map((cluster) => `${cluster.label} ${Number(cluster.count || 0)}`).join("、")}`
    : fallbackThemeText(themes);

  const priorityText = priorityBreakdownText(items);
  const attention = [
    moduleInsights.watchlist?.length ? `watchlist ${moduleInsights.watchlist.length} 条` : "",
    moduleInsights.interestMatches?.length ? `兴趣匹配 ${moduleInsights.interestMatches.length} 条` : "",
  ].filter(Boolean).join("，");

  return [clusterText, priorityText, attention].filter(Boolean).join("；") || "当前模块暂无可用的二级摘要。";
}

function safeInsightClusters(clusters = []) {
  return clusters.filter((cluster) => !genericInsightPattern.test(String(cluster.label || "")));
}

function fallbackThemeText(themes = []) {
  const safeThemes = themes
    .filter((theme) => !genericInsightPattern.test(String(theme.label || "")))
    .slice(0, 3);
  if (!safeThemes.length) return "";
  return `主题 ${safeThemes.map((theme) => `${theme.label} ${theme.count}`).join("、")}`;
}

function priorityBreakdownText(items) {
  if (!items.length) return "";
  const counts = priorityOrder
    .map((priority) => [priority, items.filter((item) => itemPriority(item) === priority).length])
    .filter(([, count]) => count > 0);
  if (!counts.length) return "";
  return `阅读队列 ${counts.map(([priority, count]) => `${priorityLabels[priority]} ${count}`).join("、")}`;
}

function buildPerformanceInsights(items, themes) {
  const meaningfulThemes = themes
    .filter((theme) => performanceFocus.tags.includes(theme.label))
    .slice(0, 4)
    .map((theme) => theme.label)
    .join(", ") || "性能信号较分散";
  const watchlist = items
    .slice()
    .sort((a, b) => performanceScore(b) - performanceScore(a) || new Date(b.date || b.updatedAt) - new Date(a.date || a.updatedAt))
    .slice(0, 8)
    .map((item) => ({ itemId: item.id, reason: performanceReason(item) }));

  return {
    summary: `性能视图按 device、block、SCSI、FS/writeback、MM、reference path 分流，当前最高频性能信号是 ${meaningfulThemes}。`,
    dailySummary: "优先看 latency/queueing、flush/writeback、runtime PM 和 UFS/Block/SCSI 交界处的变化。",
    clusters: buildPerformanceClusters(items),
    interestMatches: [],
    watchlist,
  };
}

function performanceTaxonomyItems(items, guide) {
  return items.filter((item) => {
    if (guide.modules.includes(item.module)) return true;
    const text = performanceText(item);
    return guide.terms.some((term) => text.includes(term.toLowerCase()));
  });
}

function buildPerformanceClusters(items) {
  const clusterMap = [
    { label: "latency / queueing", tags: ["latency", "queueing", "completion", "performance"], whyItMatters: "直接影响 tail latency、queue depth、polling 和 completion path。" },
    { label: "flush / writeback", tags: ["flush", "writeback", "discard"], whyItMatters: "常见于 fsync、checkpoint、dirty throttling 和掉速问题。" },
    { label: "power / clock", tags: ["power-management"], whyItMatters: "runtime PM、clock scaling、hibern8 会影响 UFS 性能和稳定性边界。" },
    { label: "recovery side effects", tags: ["timeout", "reset", "error-handling"], whyItMatters: "性能问题经常被 timeout、reset、error recovery 放大。" },
  ];

  return clusterMap.map((cluster) => {
    const matched = items.filter((item) => hasPerformanceSignal(item, cluster.tags));
    return {
      label: cluster.label,
      count: matched.length,
      riskTags: cluster.tags,
      representativeIds: matched.slice(0, 5).map((item) => item.id),
      whyItMatters: cluster.whyItMatters,
    };
  }).filter((cluster) => cluster.count);
}

function findItemById(id) {
  return allItems().find((item) => item.id === id);
}

function allItems() {
  return ["reviews", "bugs", "fixes"].flatMap((key) => state.data?.[key] || []);
}

function priorityBadge(item) {
  const priority = itemPriority(item);
  return `<span class="badge priority-${slug(priority)}">${escapeHtml(priorityLabels[priority] || priority)}</span>`;
}

function reasonBadge(item) {
  const reason = itemReason(item);
  return `<span class="badge reason-${slug(reason)}">${escapeHtml(reasonLabels[reason] || reason)}</span>`;
}

function evidenceRow(item) {
  const evidence = item.analysis?.evidence || [];
  if (!evidence.length) return "";
  return `
    <div class="evidence-row">
      ${evidence.slice(0, 3).map((entry) => `<span>${escapeHtml(entry)}</span>`).join("")}
    </div>
  `;
}

function itemPriority(item) {
  const priority = item.analysis?.priority;
  if (priorityOrder.includes(priority)) return priority;
  const tags = item.riskTags || [];
  if (item.module === "ufs" && tags.some((tag) => ["critical", "regression", "timeout", "reset", "performance", "latency", "queueing"].includes(tag))) return "must-read";
  if (item.module === "ufs" || tags.some((tag) => ["critical", "regression", "timeout", "reset"].includes(tag))) return "watch";
  if (performanceMatches(item)) return "reference";
  return "skip";
}

function itemReason(item) {
  return item.analysis?.reasonCode || fallbackReason(item);
}

function fallbackReason(item) {
  if (item.module === "ufs") return "ufs-direct";
  if (item.module === "block") return "block-path";
  if (item.module === "scsi") return "scsi-path";
  if (item.module === "f2fs") return "fs-writeback";
  if (item.module === "mm") return "mm-path";
  if (item.module === "nvme" || item.module === "io_uring") return "perf-reference";
  if ((item.riskTags || []).some((tag) => ["critical", "regression", "timeout", "reset"].includes(tag))) return "bug-risk";
  return "unrelated";
}

function decisionText(item) {
  const action = item.analysis?.nextAction || "skip";
  const confidence = item.analysis?.confidence ? ` · ${Math.round(item.analysis.confidence * 100)}%` : "";
  const hint = item.analysis?.readingHint || "根据优先级决定是否打开原始链接。";
  return `${hint} (${action}${confidence})`;
}

function itemDecisionScore(item) {
  const base = {
    "must-read": 100,
    watch: 70,
    reference: 40,
    skip: 0,
  }[itemPriority(item)] || 0;
  return base + performanceScore(item) + Number(item.analysis?.confidence || 0) * 10;
}

function buildThemes(items) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of [...(item.riskTags || []), ...(item.signals || [])]) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function isPerformanceView() {
  return state.moduleId === PERFORMANCE_VIEW_ID;
}

function performanceMatches(item) {
  if (!item) return false;
  if (hasPerformanceSignal(item, performanceFocus.tags)) return true;
  if (performanceFocus.modules.includes(item.module) && performanceTextMatches(item)) return true;
  return false;
}

function hasPerformanceSignal(item, tags) {
  const itemTags = [...(item.riskTags || []), ...(item.signals || [])].map((tag) => String(tag).toLowerCase());
  return tags.some((tag) => itemTags.includes(tag));
}

function performanceTextMatches(item) {
  const text = performanceText(item);
  return performanceFocus.terms.some((term) => text.includes(term.toLowerCase()));
}

function performanceScore(item) {
  let score = 0;
  const tags = new Set([...(item.riskTags || []), ...(item.signals || [])].map((tag) => String(tag).toLowerCase()));
  if (itemPriority(item) === "must-read") score += 30;
  if (itemPriority(item) === "watch") score += 18;
  if (itemPriority(item) === "reference") score += 8;
  for (const tag of performanceFocus.tags) if (tags.has(tag)) score += 10;
  if (item.module === "ufs") score += 8;
  if (["block", "scsi", "nvme"].includes(item.module)) score += 5;
  if (["f2fs", "mm", "io_uring"].includes(item.module)) score += 4;
  if (performanceText(item).includes("ufs")) score += 4;
  if (performanceText(item).includes("mcq")) score += 5;
  if (/fix|regression|timeout|reset/i.test(`${item.title} ${item.summary || ""}`)) score += 3;
  return score;
}

function performanceReason(item) {
  const tags = (item.riskTags || []).filter((tag) => performanceFocus.tags.includes(tag));
  const module = moduleLabel(item.module);
  if (tags.length) return `${module} · 命中 ${tags.slice(0, 3).join(", ")}，适合评估性能影响。`;
  if (performanceText(item).includes("mcq")) return `${module} · 命中 MCQ，适合看 UFS 多队列性能路径。`;
  if (performanceText(item).includes("writeback")) return `${module} · 命中 writeback，适合看真实负载掉速和尾延迟。`;
  return `${module} · 位于性能相关 I/O 路径，可作为调优背景阅读。`;
}

function performanceText(item) {
  return [
    item.title,
    item.summary,
    item.analysis?.main,
    item.analysis?.impact,
    item.analysis?.relevance,
    item.analysis?.readingHint,
    item.component,
    ...(item.files || []),
    item.context?.excerpt,
  ].filter(Boolean).join(" ").toLowerCase();
}

function buildPerformanceTrend(items) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
  const counts = Object.fromEntries(days.map((day) => [day, 0]));
  for (const item of items) {
    const date = new Date(item.date || item.updatedAt || 0);
    if (Number.isNaN(date.getTime())) continue;
    const day = date.toISOString().slice(0, 10);
    if (day in counts) counts[day] += 1;
  }
  return days.map((day) => counts[day]);
}

function moduleLabel(moduleId) {
  if (moduleId === PERFORMANCE_VIEW_ID) return performanceFocus.label;
  return state.data?.modules?.find((module) => module.id === moduleId)?.label || moduleId || "";
}

function tagRow(item) {
  const tags = [...(item.riskTags || []), ...(item.signals || [])].slice(0, 8);
  if (!tags.length) return "";
  return `<div class="tag-row">${tags.map((tag) => `<span class="badge risk-${slug(tag)}">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function stateBadge(status = "unknown") {
  return `<span class="badge state-${slug(status)}">${escapeHtml(status)}</span>`;
}

function meta(value) {
  if (!value) return "";
  return `<span class="meta">${escapeHtml(value)}</span>`;
}

function isResolved(status = "") {
  return /resolved|closed|fixed|mainlined|accepted/i.test(status);
}

function formatDate(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatRelative(date) {
  if (Number.isNaN(date.getTime())) return "unknown";
  const diffHours = Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.round(diffHours / 24)}d ago`;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function cleanInsightText(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || genericInsightPattern.test(text)) return fallback;
  return text;
}

const fallbackSnapshot = {
  generatedAt: new Date().toISOString(),
  defaultModule: "ufs",
  sources: [
    { name: "Patchwork", kind: "patches", url: "https://patchwork.kernel.org/" },
    { name: "Kernel Bugzilla", kind: "bugs", url: "https://bugzilla.kernel.org/" },
    { name: "syzbot", kind: "fuzzing", url: "https://syzbot.org/upstream/subsystems" },
  ],
  modules: [
    { id: "ufs", label: "UFS", paths: ["drivers/ufs/"], trend: { reviews: [1, 2, 2, 3, 2, 4, 3], bugs: [0, 1, 0, 1, 1, 0, 1], fixes: [0, 1, 1, 0, 1, 2, 1] } },
    { id: "scsi", label: "SCSI", paths: ["drivers/scsi/"], trend: { reviews: [4, 5, 3, 6, 7, 5, 6], bugs: [1, 2, 2, 1, 3, 2, 2], fixes: [1, 1, 2, 1, 2, 2, 3] } },
    { id: "block", label: "Block", paths: ["block/"], trend: { reviews: [6, 7, 5, 8, 8, 7, 9], bugs: [2, 3, 2, 2, 4, 3, 3], fixes: [2, 3, 2, 3, 4, 2, 3] } },
    { id: "nvme", label: "NVMe", paths: ["drivers/nvme/"], trend: { reviews: [2, 3, 2, 4, 3, 5, 4], bugs: [1, 1, 2, 1, 2, 1, 2], fixes: [1, 2, 1, 2, 2, 3, 2] } },
    { id: "mmc", label: "MMC", paths: ["drivers/mmc/"], trend: { reviews: [1, 1, 2, 1, 2, 3, 2], bugs: [0, 1, 1, 0, 1, 1, 1], fixes: [0, 1, 0, 1, 1, 1, 2] } },
  ],
  reviews: [
    {
      id: "fallback-ufs-review",
      module: "ufs",
      title: "scsi: ufs: example patch series",
      status: "new",
      date: new Date().toISOString(),
      submitter: "Patchwork",
      version: 1,
      series: "daily snapshot unavailable",
      url: "https://patchwork.kernel.org/project/linux-scsi/list/",
      riskTags: ["reset", "error-handling"],
      signals: ["needs review"],
      summary: "运行每日同步脚本后这里会替换为真实 patch series。",
    },
  ],
  bugs: [],
  fixes: [],
};

boot();
