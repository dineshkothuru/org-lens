const APP_VERSION = "v2.09 · 2026-08-23";
const API_VERSION = "v61.0";
const SKIP_SUFFIXES = ["Share", "History", "Feed", "ChangeEvent", "Tag"];
const CONCURRENCY = 8;

const $ = (id) => document.getElementById(id);
let auth = null; // { accessToken, instanceUrl }

// ---------- helpers ----------
function setStatus(msg, cls = "") {
  const el = auth ? $("status") : $("landingStatus");
  const txt = auth ? $("statusText") : $("landingStatusText");
  txt.textContent = msg;
  el.className = "status " + cls;
  // The status line sits at the foot of the card, below every panel, so on a long panel a
  // failure could land off-screen while you stare at the controls that caused it. Errors are
  // therefore mirrored next to the buttons of whichever panel is open.
  showPanelError(cls === "err" ? msg : "");
}

// one error slot per panel, sitting immediately under its first row of buttons
function panelErrorSlot() {
  const panel = PANELS.map(id => $(id)).find(p => p && p.style.display !== "none");
  if (!panel) return null;
  let slot = panel.querySelector(".inlineerr");
  if (!slot) {
    // by default the error sits under the buttons that triggered it; where a panel has one
    // obvious input, it belongs under that instead, which is where the eye already is
    const ANCHOR = { panelSoql: ".acwrap", panelDeps: ".btnrow", panelCode: ".btnrow" };
    const anchor = panel.querySelector(ANCHOR[panel.id] || ".btnrow") || panel.querySelector(".btnrow");
    if (!anchor) return null;
    slot = document.createElement("div");
    slot.className = "inlineerr";
    slot.style.display = "none";
    anchor.insertAdjacentElement("afterend", slot);
  }
  return slot;
}

function showPanelError(msg) {
  // clear any stale message in other panels, so switching away does not leave one behind
  document.querySelectorAll(".inlineerr").forEach(el => {
    if (!msg) { el.style.display = "none"; el.textContent = ""; }
  });
  if (!msg) return;
  const slot = panelErrorSlot();
  if (!slot) return;
  slot.textContent = msg;
  slot.style.display = "block";
  const box = slot.getBoundingClientRect();
  if (box.top < 0 || box.bottom > innerHeight) slot.scrollIntoView({ block: "center" });
}
function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- session auth (extension: rides your existing Salesforce login) ----------
const ask = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

async function loadOrgs({ autoConnect = false } = {}) {
  const r = await ask({ type: "listOrgs" });
  const sel = $("orgPick");
  if (!r?.ok || !r.orgs.length) {
    sel.innerHTML = `<option value="">No logged-in Salesforce orgs found</option>`;
    setStatus("Log into a Salesforce org in another tab, then click Refresh.", "err");
    return;
  }
  sel.innerHTML = r.orgs.map(o => `<option value="${o.host}">${o.label || o.host}</option>`).join("");
  const pre = new URLSearchParams(location.hash.replace(/^#/, "")).get("org");
  const match = pre ? r.orgs.find(o => o.label === pre || o.host === pre) : null;
  if (match) sel.value = match.host;
  setStatus(r.orgs.length === 1 ? "" : `${r.orgs.length} org sessions available.`);
  // one org, or you clicked the icon from a Salesforce tab → go straight in
  if (autoConnect && (r.orgs.length === 1 || match)) connect();
}

async function connect() {
  const host = $("orgPick").value;
  if (!host) return setStatus("No org selected. Log into Salesforce in another tab first.", "err");
  setStatus("Opening session…", "busy");
  const r = await ask({ type: "session", host });
  if (!r?.ok) return setStatus(r?.error || "Could not read the session for that org.", "err");
  auth = { accessToken: r.session.token, instanceUrl: `https://${host}` };
  try { sessionStorage.setItem("sf_auth", JSON.stringify(auth)); } catch {}
  showConnected();
}

async function showConnected() {
  $("landing").style.display = "none";
  $("app").style.display = "flex";
  setStatus("");
  $("whoami").textContent = auth.instanceUrl.replace("https://", "");
  showEnvBadge();
  fitLayout();
  loadHealth();
  try {
    const me = await api(`/services/oauth2/userinfo`, true);
    $("whoami").textContent = `${me.name} · ${me.preferred_username} · ${auth.instanceUrl.replace("https://", "")}`;
    $("whoami").title = $("whoami").textContent;      // the full string, since it truncates
    fitLayout();
  } catch { /* keep instance url */ }
}

function disconnect() {
  sessionByHost.clear();
  sessionStorage.removeItem("sf_auth");
  sessionStorage.removeItem("sf_panel");
  auth = null;
  auth2 = null;
  mxSlots = [];
  orgIsSandbox = null;
  $("envBadge").style.display = "none";
  document.querySelector(".topbar").classList.remove("prod");
  loadOrgs();
  allObjects = null;
  selectedObjs.clear();
  $("pickObjects").checked = false;
  $("picker").style.display = "none";
  $("healthTiles").innerHTML = "";
  $("orgFacts").innerHTML = "";
  $("invTiles").innerHTML = "";
  invCache = null;
  browserInited = false;
  profsLoaded = false;
  $("bObjList").innerHTML = "";
  $("bFieldView").style.display = "none";
  $("bFLSInline").style.display = "none";
  $("bRTInline").style.display = "none";
  $("bObjView").style.display = "block";
  profileListCache = null;
  bSelectedObj = null;
  bSelectedField = null;
  permSel.clear();
  autoSel.clear();
  usageSel.clear();
  usageInited = false;
  autoInited = false;
  $("autoResult").style.display = "none";
  permInited = false;
  $("permResult").style.display = "none";
  $("app").style.display = "none";
  $("landing").style.display = "block";
  setStatus("Session closed in Org Lens. Your Salesforce tabs stay logged in.");
}

// ---------- side nav ----------
let orgIsSandbox = null;      // true, false, or null when the org type could not be read
const PANELS = ["panelHealth", "panelAudit", "panelTests", "panelCounts", "panelJobs", "panelErd", "panelCode", "panelSoql", "panelSchema", "panelPackage", "panelCompare", "panelPerms", "panelAuto", "panelDeps", "panelUsage", "panelBrowser", "panelProfCmp", "panelUserAccess", "panelDoc", "panelSecurity", "panelSharing"];
// Result cards are per-run snapshots, so drop them whenever the panel changes —
// otherwise you come back to a panel showing results for a different selection.
const RESULT_BOXES = ["permResult", "autoResult", "usageResult", "depsResult", "pkgResult", "unusedResult", "profResult", "orgResult", "mxResult", "uaResult", "soqlResult", "codeResult", "codeListResult", "auditResult", "testsResult", "countsResult", "jobsResult", "erdResult", "bFLSInline", "bRTInline", "docResult", "secResult", "shResult", "mdResult", "pmxResult", "limitsBox", "shApexBox", "codeHitBox"];
function hideResultBoxes() {
  for (const b of RESULT_BOXES) {
    const el = $(b);
    if (el) { el.style.display = "none"; el.classList.remove("flash"); }
    // the limits table is a toggle, so its button has to agree with it
    if (b === "limitsBox" && $("limitsToggleLabel")) $("limitsToggleLabel").textContent = "Show all limits";
  }
  bSelectedField = null;
  showPanelHint();
}

// A panel's object selection belongs to that panel's run, so reset the pickers
// (and their search boxes) when the user moves to another panel.
function resetPickers() {
  const pickers = [
    { set: permSel, list: "permList", search: "permSearch", count: "permCount", render: () => (typeof renderPermList === "function") && renderPermList(), empty: "0 selected" },
    { set: autoSel, list: "autoList", search: "autoSearch", count: "autoCount", render: () => (typeof renderAutoList === "function") && renderAutoList(), empty: "0 selected (whole org)" },
    { set: usageSel, list: "usageList", search: "usageSearch", count: "usageCount", render: () => (typeof renderUsageList === "function") && renderUsageList(), empty: "0 selected" },
    { set: erdSel, list: "erdList", search: "erdSearch", count: "erdCount", render: () => (typeof renderErdList === "function") && renderErdList(), empty: "0 selected" },
    { set: selectedObjs, list: "pickerList", search: "pickerSearch", count: "pickCount", render: () => (typeof renderPicker === "function") && renderPicker(), empty: "0 selected" },
  ];
  for (const p of pickers) {
    if (!p.set) continue;
    p.set.clear();
    const s = $(p.search); if (s) s.value = "";
    const c = $(p.count); if (c) c.textContent = p.empty;
    try { p.render(); } catch { /* list not built yet */ }
  }
}

function showPanel(id) {
  hideResultBoxes();
  resetPickers();
  for (const p of PANELS) $(p).style.display = p === id ? "block" : "none";
  document.querySelectorAll(".navitem").forEach(b =>
    b.classList.toggle("active", b.dataset.panel === id));
  setStatus("");
  fitLayout();
  if (auth) sessionStorage.setItem("sf_panel", id);
  if (auth && id === "panelBrowser") initBrowser();
  if (auth && id === "panelProfCmp") initProfCmp();
  if (auth && id === "panelCompare") loadMxOrgs();
  if (auth && id === "panelDoc") initDoc();
  if (auth && id === "panelPerms") initPerms();
  if (auth && id === "panelAuto") initAuto();
  if (auth && id === "panelUsage") initUsage();
  if (auth && id === "panelErd") initErd();
  if (auth && id === "panelDeps" && !depsInited) loadDepNames();
}

// Which org am I pointed at? The host usually hints, but "acme.my.salesforce.com" could be
// either, so the answer comes from Organization.IsSandbox. Production is called out loudly
// because every panel here reads live data and some people run it from habit.
async function showEnvBadge() {
  const badge = $("envBadge");
  const bar = document.querySelector(".topbar");
  badge.style.display = "inline-block";
  badge.className = "envbadge unknown";
  badge.textContent = "checking…";
  bar.classList.remove("prod");
  try {
    const rows = await stdQuery("SELECT Name, IsSandbox, OrganizationType, InstanceName FROM Organization");
    const org = rows[0];
    if (!org) throw new Error("no Organization row");
    orgIsSandbox = !!org.IsSandbox;
    badge.className = "envbadge " + (org.IsSandbox ? "sandbox" : "prod");
    badge.textContent = org.IsSandbox ? "Sandbox" : "Production";
    badge.title = [org.Name, org.OrganizationType, org.InstanceName && "instance " + org.InstanceName]
      .filter(Boolean).join(" · ");
    if (!org.IsSandbox) bar.classList.add("prod");
  } catch (err) {
    // a user without access to Organization still deserves to know it is unverified
    badge.className = "envbadge unknown";
    badge.textContent = "org type unknown";
    badge.title = "Could not read the Organization record: " + err.message;
  }
}

// The panel and nav caps used to be a guess at how much room the top bar and footer take.
// Guessing means that when the bar grows, by a line wrapping or a badge appearing, the sum
// exceeds the window and something gets squeezed. Measuring it removes the whole class of
// bug: whatever the chrome actually costs, the columns get the rest.
function fitLayout() {
  const app = $("app");
  if (!app || app.style.display === "none") return;
  const bar = document.querySelector(".topbar");
  const foot = document.querySelector(".page-foot");
  const body = getComputedStyle(document.body);
  const chrome =
    parseFloat(body.paddingTop || 0) + parseFloat(body.paddingBottom || 0) +
    (bar ? bar.offsetHeight + parseFloat(getComputedStyle(bar).marginBottom || 0) : 0) +
    (foot ? foot.offsetHeight + parseFloat(getComputedStyle(foot).marginTop || 0) : 0) + 4;
  document.documentElement.style.setProperty("--fitH", `calc(100vh - ${Math.round(chrome)}px)`);
}

let fitTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitLayout, 120);
});

// ---------- API (dual-org aware) ----------
async function apiFor(a, path, absoluteFromInstance = false) {
  const url = absoluteFromInstance ? a.instanceUrl + path
                                   : `${a.instanceUrl}/services/data/${API_VERSION}${path}`;
  const resp = await fetch(url, { headers: { Authorization: "Bearer " + a.accessToken } });
  if (resp.status === 401) {
    if (a === auth) { disconnect(); throw new Error("Session expired. Please reconnect."); }
    throw new Error("Second org session expired. Please reconnect it.");
  }
  if (!resp.ok) {
    let msg = "";
    try {
      const body = await resp.json();
      msg = (Array.isArray(body) ? body[0]?.message : body.message || body.error_description) || "";
    } catch { /* non-JSON body */ }
    throw new Error(msg ? `${msg} (HTTP ${resp.status})` : `HTTP ${resp.status} on ${path.split("?")[0]}`);
  }
  return resp.json();
}
const api = (path, abs) => apiFor(auth, path, abs);
async function stdQueryFor(a, soql) {
  let path = `/query/?q=${encodeURIComponent(soql)}`;
  const records = [];
  while (path) {
    const r = await apiFor(a, path);
    records.push(...(r.records || []));
    path = r.nextRecordsUrl ? r.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, "") : null;
  }
  return records;
}
const stdQuery = (soql) => stdQueryFor(auth, soql);
async function toolingQueryFor(a, soql) {
  let path = `/tooling/query/?q=${encodeURIComponent(soql)}`;
  const records = [];
  while (path) {
    const r = await apiFor(a, path);
    records.push(...(r.records || []));
    path = r.nextRecordsUrl ? r.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, "") : null;
  }
  return records;
}
const toolingQuery = (soql) => toolingQueryFor(auth, soql);

// shared: describe a list of objects against an org, with progress
async function describeAllFor(a, names, tag) {
  const describes = {};
  let done = 0;
  const queue = [...names];
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      try { describes[name] = await apiFor(a, `/sobjects/${name}/describe/`); }
      catch (e) { console.warn("describe failed", name, e); }
      done++;
      setStatus(`Describing ${tag}… ${done}/${names.length}`, "busy");
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return describes;
}

// shared workbook helpers
function sheetFromRows(wb, rows, name, maxW = 55) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!autofilter"] = { ref: ws["!ref"] };
  ws["!cols"] = rows[0].map((_, i) => ({ wch: Math.min(maxW, Math.max(12, ...rows.slice(0, 500).map(r => String(r[i] ?? "").length)) + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, name);
  return ws;
}
function hostOf(a) { return new URL(a.instanceUrl).hostname.split(".")[0]; }
// full api hostname, the key every org list and session lookup uses
function apiHostOf(a) { return new URL(a.instanceUrl).hostname; }
function today() { return new Date().toISOString().slice(0, 10); }
function downloadBlob(filename, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function downloadText(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/xml" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- org health ----------
function fmt(n) { return Number(n).toLocaleString("en-IN"); }
async function loadHealth() {
  const st = $("healthStatus");
  st.className = "status busy";
  st.lastElementChild.textContent = "Loading org limits…";
  try {
    const [limits, orgRows, userRes] = await Promise.all([
      api("/limits/"),
      stdQuery("SELECT Name, OrganizationType, IsSandbox, InstanceName FROM Organization"),
      api(`/query/?q=${encodeURIComponent("SELECT COUNT() FROM User WHERE IsActive = true AND UserType = 'Standard'")}`),
    ]);
    const org = orgRows[0] || {};
    $("orgFacts").innerHTML = [
      org.Name ? `<span class="fact"><b>${org.Name}</b></span>` : "",
      org.OrganizationType ? `<span class="fact">${org.OrganizationType}</span>` : "",
      `<span class="fact">${org.IsSandbox ? "Sandbox" : "Production"}</span>`,
      org.InstanceName ? `<span class="fact">Instance <b>${org.InstanceName}</b></span>` : "",
      userRes?.totalSize != null ? `<span class="fact"><b>${fmt(userRes.totalSize)}</b>&nbsp;active users</span>` : "",
    ].join("");

    allLimits = limits;
    if ($("limitsBox").style.display === "block") renderLimits();
    const defs = [
      ["DailyApiRequests", "API requests (24h)", ""],
      ["DataStorageMB", "Data storage", " MB"],
      ["FileStorageMB", "File storage", " MB"],
      ["DailyAsyncApexExecutions", "Async Apex (24h)", ""],
      ["DailyBulkApiBatches", "Bulk API batches (24h)", ""],
      ["MassEmail", "Mass email (24h)", ""],
    ];
    $("healthTiles").innerHTML = defs.map(([key, label, unit], i) => {
      const o = limits[key];
      if (!o || !o.Max) return "";
      const used = o.Max - o.Remaining;
      const pct = Math.min(100, Math.round(used / o.Max * 100));
      const cls = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
      return `<div class="tile c${i % 6} ${cls}">
        <div class="tl">${label}</div>
        <div class="tv">${fmt(used)}<small> / ${fmt(o.Max)}${unit}</small></div>
        <div class="tbar"><div style="width:${pct}%"></div></div>
        <div class="tp">${pct}% used</div>
      </div>`;
    }).join("");
    st.className = "status";
    st.lastElementChild.textContent = "";
  } catch (e) {
    st.className = "status";
    st.lastElementChild.textContent =
      "Org health unavailable for this user (usually needs the 'View Setup and Configuration' permission). Exports still work.";
    console.warn("health failed:", e);
  }
  loadInventory();
}

async function fetchInventory() {
  const stdCount = async (soql) => (await api(`/query/?q=${encodeURIComponent(soql)}`)).totalSize;
  const toolCount = async (soql) => {
    try { return (await api(`/tooling/query/?q=${encodeURIComponent(soql)}`)).totalSize; }
    catch { // some Tooling entities reject COUNT() — fall back to counting ids
      const r = await api(`/tooling/query/?q=${encodeURIComponent(soql.replace("COUNT()", "Id"))}`);
      return r.totalSize;
    }
  };
  const items = [
    ["Custom objects", () => toolCount("SELECT COUNT() FROM CustomObject")],
    ["Custom fields", () => toolCount("SELECT COUNT() FROM CustomField")],
    ["Apex classes", () => stdCount("SELECT COUNT() FROM ApexClass")],
    ["Apex triggers", () => stdCount("SELECT COUNT() FROM ApexTrigger")],
    ["LWC bundles", () => toolCount("SELECT COUNT() FROM LightningComponentBundle")],
    ["Aura bundles", () => toolCount("SELECT COUNT() FROM AuraDefinitionBundle")],
    ["Visualforce pages", () => stdCount("SELECT COUNT() FROM ApexPage")],
    ["Active flows", () => stdCount("SELECT COUNT() FROM FlowDefinitionView WHERE IsActive = true")],
    ["Inactive flows", () => stdCount("SELECT COUNT() FROM FlowDefinitionView WHERE IsActive = false")],
    ["Validation rules", () => toolCount("SELECT COUNT() FROM ValidationRule")],
    ["Profiles", () => stdCount("SELECT COUNT() FROM Profile")],
    ["Permission sets", () => stdCount("SELECT COUNT() FROM PermissionSet WHERE IsOwnedByProfile = false")],
    ["Reports", () => stdCount("SELECT COUNT() FROM Report")],
    ["Dashboards", () => stdCount("SELECT COUNT() FROM Dashboard")],
    // OmniStudio (standard runtime) — absent orgs just skip these tiles
    ["OmniScripts", () => stdCount("SELECT COUNT() FROM OmniProcess WHERE IsIntegrationProcedure = false")],
    ["Integration procedures", () => stdCount("SELECT COUNT() FROM OmniProcess WHERE IsIntegrationProcedure = true")],
    ["FlexCards", () => stdCount("SELECT COUNT() FROM OmniUiCard")],
    ["DataRaptors", () => stdCount("SELECT COUNT() FROM OmniDataTransform")],
  ];
  const results = await Promise.allSettled(items.map(([, fn]) => fn()));
  return items.map(([label], i) => ({
    label, value: results[i].status === "fulfilled" ? results[i].value : null,
  })).filter(x => x.value != null);
}

let invCache = null;
async function loadInventory() {
  invCache = await fetchInventory();
  $("invTiles").innerHTML = invCache.map((x, i) => `<div class="tile c${i % 6}">
      <div class="tl">${x.label}</div>
      <div class="tv">${fmt(x.value)}</div>
    </div>`).join("") || `<div class="sub2">Inventory counts unavailable for this user.</div>`;
}

// ---------- object picker ----------
let allObjects = null;
const selectedObjs = new Set();

async function loadObjectList() {
  if (allObjects) return allObjects;
  const g = await api("/sobjects/");
  allObjects = g.sobjects
    .filter(s => s.queryable && !SKIP_SUFFIXES.some(x => s.name.endsWith(x)))
    .sort((a, b) => a.label.localeCompare(b.label));
  return allObjects;
}

function shownObjects() {
  const q = $("pickerSearch").value.trim().toLowerCase();
  let list = allObjects || [];
  if ($("customOnly").checked) list = list.filter(s => s.custom);
  if (q) list = list.filter(s => s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  return list;
}

function renderPicker() {
  const list = shownObjects().slice(0, 400);
  $("pickerList").innerHTML = list.map(s => `
    <label><input type="checkbox" data-obj="${s.name}" ${selectedObjs.has(s.name) ? "checked" : ""}>
    ${s.label}<span class="api">${s.name}</span></label>`).join("") ||
    `<div style="padding:10px; font-size:13px; color:var(--faint);">No objects match.</div>`;
  $("pickCount").textContent = `${selectedObjs.size} selected`;
}

async function togglePicker() {
  const on = $("pickObjects").checked;
  $("picker").style.display = on ? "block" : "none";
  if (on && !allObjects) {
    setStatus("Loading object list…", "busy");
    try { await loadObjectList(); setStatus(""); }
    catch (e) { setStatus(`Could not load objects: ${e.message}`, "err"); return; }
  }
  if (on) renderPicker();
}





// ---------- layout engine ----------
// ELK ("Eclipse Layout Kernel") is what professional ERD/BPMN editors use: it assigns
// nodes to layers, minimises crossings, and routes edges as right angles that avoid
// boxes. Vendored locally because MV3 forbids remote scripts. If it fails to load we
// fall back to the built-in force layout so the panel still works.
async function erdLayout(nodes, edges, opts) {
  if (typeof ELK === "undefined") return null;
  const elk = new ELK();
  const dense = opts.dense;
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": opts.dir || "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": dense ? "70" : "110",
      "elk.spacing.nodeNode": dense ? "40" : "70",
      "elk.spacing.edgeNode": dense ? "20" : "30",
      "elk.spacing.edgeEdge": "14",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeLabels.inline": "true",
      "elk.spacing.edgeLabel": "6",
    },
    children: nodes.map(n => ({ id: n.id, width: n.w, height: n.h })),
    // A lookup points child -> parent, but an ERD reads parent above child, so feed the
    // layout parent -> child and reverse the route when drawing (arrow still at the parent).
    edges: edges.map((e, i) => ({
      id: `e${i}`, sources: [e.to], targets: [e.from],
      labels: (dense || !e.field) ? [] : [{ text: e.field, width: e.field.length * 5.6 + 8, height: 13 }],
    })),
  };
  try {
    const res = await elk.layout(graph);
    const pos = new Map((res.children || []).map(c => [c.id, c]));
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (p) { n.x = p.x + n.w / 2; n.y = p.y + n.h / 2; }
    }
    // ELK returns each edge as sections of straight segments plus label positions
    const routes = new Map();
    for (const le of res.edges || []) {
      const pts = [];
      for (const s of le.sections || []) {
        pts.push([s.startPoint.x, s.startPoint.y]);
        for (const b of s.bendPoints || []) pts.push([b.x, b.y]);
        pts.push([s.endPoint.x, s.endPoint.y]);
      }
      const lab = (le.labels || [])[0];
      pts.reverse();   // draw child -> parent so the arrowhead lands on the parent
      routes.set(le.id, { pts, label: lab ? { x: lab.x + (lab.width || 0) / 2, y: lab.y + (lab.height || 0) / 2 } : null });
    }
    return { routes, w: (res.width || 0), h: (res.height || 0) };
  } catch (err) {
    console.warn("ELK layout failed, using the force fallback:", err);
    return null;
  }
}

// rounded right-angle path through ELK's points

// The points of an elbow route, so hop detection can work on segments rather than
// on a finished path string.
function elbowPts(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const x1 = a.x + (horizontal ? Math.sign(dx) * a.w / 2 : 0);
  const y1 = a.y + (horizontal ? 0 : Math.sign(dy) * a.h / 2);
  const x2 = b.x - (horizontal ? Math.sign(dx) * b.w / 2 : 0);
  const y2 = b.y - (horizontal ? 0 : Math.sign(dy) * b.h / 2);
  const mid = horizontal ? [(x1 + x2) / 2, y1] : [x1, (y1 + y2) / 2];
  const mid2 = horizontal ? [(x1 + x2) / 2, y2] : [x2, (y1 + y2) / 2];
  return [[x1, y1], mid, mid2, [x2, y2]];
}

// Routes arrive with duplicate waypoints and collinear kinks (an elbow whose two mid
// points coincide, for instance). Left in, they split one straight run into two, and a
// crossing then lands on a shared endpoint where hop detection cannot see it. They also
// emit degenerate curve commands. So every route is simplified before it is used.
function simplifyPts(pts) {
  if (!pts || pts.length < 2) return pts || [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = out[out.length - 1], [cx, cy] = pts[i];
    if (Math.abs(cx - px) < 0.6 && Math.abs(cy - py) < 0.6) continue;      // duplicate
    if (out.length >= 2) {
      const [ax, ay] = out[out.length - 2];
      const collinearH = Math.abs(ay - py) < 0.6 && Math.abs(py - cy) < 0.6;
      const collinearV = Math.abs(ax - px) < 0.6 && Math.abs(px - cx) < 0.6;
      if (collinearH || collinearV) { out[out.length - 1] = [cx, cy]; continue; }
    }
    out.push([cx, cy]);
  }
  return out;
}

const HOP_R = 4.5;      // arc radius, small enough not to read as a corner

// Every vertical segment in the diagram, so a horizontal run can arc over the ones
// it crosses. Only horizontals hop, which is the usual convention: pick one axis and
// stay with it, or two crossing lines both bulge and the crossing looks like a knot.
function verticalSegs(routes) {
  const segs = [];
  for (const pts of routes) {
    // Collect this route's verticals, then merge the collinear ones. A route that turns at
    // a waypoint arrives as two segments meeting at that point, and an unmerged pair puts
    // the crossing exactly on a shared endpoint, where it would be missed.
    const mine = [];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
      if (Math.abs(x1 - x2) < 0.6 && Math.abs(y1 - y2) > 2) {
        mine.push({ x: x1, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
      }
    }
    mine.sort((a, b) => a.x - b.x || a.y1 - b.y1);
    for (const s of mine) {
      const last = segs[segs.length - 1];
      if (last && Math.abs(last.x - s.x) < 0.6 && s.y1 <= last.y2 + 1) last.y2 = Math.max(last.y2, s.y2);
      else segs.push({ ...s });
    }
  }
  return segs;
}

// Same rounded-corner walk as orthoPath, with arcs inserted wherever a horizontal
// run crosses a vertical belonging to another edge.
function hopPath(pts, verticals, r = 8) {
  if (!pts || pts.length < 2) return "";
  const f = (n) => n.toFixed(1);
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;

  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i];
    const isLast = i === pts.length - 1;

    // where the straight part of this segment ends: short of the corner if one follows
    let ex = cx, ey = cy;
    if (!isLast) {
      const [nx, ny] = pts[i + 1];
      const d1 = Math.hypot(cx - px, cy - py), d2 = Math.hypot(nx - cx, ny - cy);
      const rr = Math.max(0, Math.min(r, d1 / 2, d2 / 2));
      ex = cx - (cx - px) / (d1 || 1) * rr;
      ey = cy - (cy - py) / (d1 || 1) * rr;
    }

    const horizontal = Math.abs(cy - py) < 0.6 && Math.abs(cx - px) > 2;
    if (horizontal && verticals.length) {
      const dir = Math.sign(ex - px) || 1;
      const lo = Math.min(px, ex), hi = Math.max(px, ex);
      const hits = verticals
        .filter(v => v.x > lo + HOP_R * 2 && v.x < hi - HOP_R * 2 && py > v.y1 + 1 && py < v.y2 - 1)
        .map(v => v.x)
        .sort((a, b) => (a - b) * dir);
      for (const hx of hits) {
        d += ` L ${f(hx - HOP_R * dir)} ${f(py)}`;
        // sweep chosen so the bump always sits above the line, whichever way it runs
        d += ` A ${HOP_R} ${HOP_R} 0 0 ${dir > 0 ? 1 : 0} ${f(hx + HOP_R * dir)} ${f(py)}`;
      }
    }

    d += ` L ${f(ex)} ${f(ey)}`;
    if (!isLast) {
      const [nx, ny] = pts[i + 1];
      const d2 = Math.hypot(nx - cx, ny - cy);
      const rr = Math.max(0, Math.min(r, Math.hypot(cx - px, cy - py) / 2, d2 / 2));
      const bx = cx + (nx - cx) / (d2 || 1) * rr, by = cy + (ny - cy) / (d2 || 1) * rr;
      d += ` Q ${f(cx)} ${f(cy)} ${f(bx)} ${f(by)}`;
    }
  }
  return d;
}

function orthoPath(pts, r = 8) {
  if (!pts || pts.length < 2) return "";
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py), d2 = Math.hypot(nx - cx, ny - cy);
    const rr = Math.max(0, Math.min(r, d1 / 2, d2 / 2));
    const ax = cx - (cx - px) / (d1 || 1) * rr, ay = cy - (cy - py) / (d1 || 1) * rr;
    const bx = cx + (nx - cx) / (d2 || 1) * rr, by = cy + (ny - cy) / (d2 || 1) * rr;
    d += ` L ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

// after a manual drag the ELK route is stale, so fall back to a clean manhattan elbow
function elbowPath(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const x1 = a.x + (horizontal ? Math.sign(dx) * a.w / 2 : 0);
  const y1 = a.y + (horizontal ? 0 : Math.sign(dy) * a.h / 2);
  const x2 = b.x - (horizontal ? Math.sign(dx) * b.w / 2 : 0);
  const y2 = b.y - (horizontal ? 0 : Math.sign(dy) * b.h / 2);
  const mid = horizontal ? [(x1 + x2) / 2, y1] : [x1, (y1 + y2) / 2];
  const mid2 = horizontal ? [(x1 + x2) / 2, y2] : [x2, (y1 + y2) / 2];
  return orthoPath([[x1, y1], mid, mid2, [x2, y2]]);
}


// ---------- diagram interactions ----------
// click the + on a box to pull in its neighbours without rebuilding the picture
async function erdExpandNode(id) {
  if (!erdModel) return;
  const budget = Number($("erdBudget").value);
  if (erdModel.nodes.length >= budget) {
    setStatus(`Budget reached (${budget} boxes). Raise “Maximum boxes” to expand further.`, "err");
    return;
  }
  try {
    setStatus(`Expanding ${id}…`, "busy");
    const known = new Map((allObjects || []).map(o => [o.name, o]));
    const d = descCache[id] = descCache[id] || await api(`/sobjects/${id}/describe/`);
    const have = new Set(erdModel.nodes.map(n => n.id));
    const wanted = new Set();
    for (const f of d.fields || []) if (f.type === "reference") for (const t of f.referenceTo || []) wanted.add(t);
    for (const c of d.childRelationships || []) if (c.childSObject) wanted.add(c.childSObject);
    const customOnly = $("erdCustomOnly").checked;
    const add = [...wanted].filter(t => known.has(t) && !have.has(t) && (!customOnly || known.get(t).custom));
    if (!add.length) { setStatus("Nothing new to add for that object.", "ok"); return; }
    for (const t of add) {
      if (erdModel.nodes.length >= budget) break;
      erdSel.add(t);
      have.add(t);
    }
    renderErdList();
    await erdDraw();                       // rebuild + re-layout with the wider set
    setStatus(`Added ${add.length} related object${add.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    setStatus(`Expand failed: ${err.message}`, "err");
  }
}

// hovering a box dims everything not connected to it
function erdFocus(id) {
  const svg = $("erdSvg");
  if (!id) {
    svg.classList.remove("focusing");
    svg.querySelectorAll(".lit").forEach(el => el.classList.remove("lit"));
    return;
  }
  const keep = new Set([id]);
  for (const e of erdModel?.edges || []) {
    if (e.from === id) keep.add(e.to);
    if (e.to === id) keep.add(e.from);
  }
  svg.classList.add("focusing");
  svg.querySelectorAll(".node").forEach(g => g.classList.toggle("lit", keep.has(g.dataset.id)));
  svg.querySelectorAll(".edge").forEach(p => {
    const on = p.dataset.from === id || p.dataset.to === id;
    p.classList.toggle("lit", on);
  });
}

// zoom the whole drawing into the visible area
function erdFit() {
  if (!erdModel) return;
  const svg = $("erdSvg");
  const r = svg.getBoundingClientRect();
  const vb = (svg.getAttribute("viewBox") || "0 0 1 1").split(" ").map(Number);
  // the viewBox already spans the drawing, so fitting means resetting the transform
  erdView = { k: 1, x: 0, y: 0 };
  applyErdView();
  setStatus("");
}

// remember box positions per object-set, so a redrawn diagram looks the same
const erdLayoutKey = () => "erdLayout:" + [...erdSel].sort().join(",") + ":" + $("erdDir").value;
function saveErdLayout() {
  if (!erdModel) return;
  const data = Object.fromEntries(erdModel.nodes.map(n => [n.id, [Math.round(n.x), Math.round(n.y)]]));
  try { chrome.storage?.local?.set({ [erdLayoutKey()]: data }); } catch {}
}
async function loadErdLayout() {
  try {
    const key = erdLayoutKey();
    const got = await new Promise(res => chrome.storage.local.get([key], v => res(v?.[key])));
    return got || null;
  } catch { return null; }
}

// ---------- Schema diagram (ERD) ----------
// Layout is a small force simulation: springs along relationships, repulsion between
// boxes. n is capped at 12, so a few hundred ticks settle instantly and we avoid
// shipping a graph library (which MV3's CSP would block from a CDN anyway).
const erdSel = new Set();
let erdInited = false;
let erdModel = null;   // { nodes, edges, w, h }
let erdView = { k: 1, x: 0, y: 0 };

async function initErd() {
  if (erdInited) return;
  try {
    setStatus("Loading object list…", "busy");
    await loadObjectList();
    erdInited = true;
    setStatus("");
    renderErdList();
  } catch (err) { setStatus("Could not load objects: " + err.message, "err"); }
}

function renderErdList() {
  const q = $("erdSearch").value.trim().toLowerCase();
  const list = (allObjects || [])
    .filter(s => !q || s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .slice(0, 300);
  $("erdList").innerHTML = list.map(s =>
    '<label><input type="checkbox" data-eobj="' + escHtml(s.name) + '"' + (erdSel.has(s.name) ? " checked" : "") + '>' +
    hl(s.label, q) + '<span class="api">' + hl(s.name, q) + '</span></label>').join("")
    || '<div style="padding:10px; font-size:13px; color:var(--faint);">No objects match.</div>';
  $("erdCount").textContent = erdSel.size + " selected";
}

const ERD_MAX = 12;

async function buildErdModel() {
  if (!erdSel.size) throw new Error("Tick at least one object.");
  const budget = Number($("erdBudget").value);
  const depth = Number($("erdDepth").value);
  const customOnly = $("erdCustomOnly").checked;
  if (erdSel.size > budget) throw new Error(`You picked ${erdSel.size} objects but the budget is ${budget} boxes. Raise the budget or pick fewer.`);

  const known = new Map((allObjects || []).map(o => [o.name, o]));
  const seeds = [...erdSel];
  const names = [...seeds];
  const desc = {};
  let truncated = 0;

  const describe = async (n) => (desc[n] = descCache[n] = descCache[n] || await api(`/sobjects/${n}/describe/`));

  setStatus("Describing objects…", "busy");
  for (let i = 0; i < names.length; i++) { await describe(names[i]); setProgress(Math.round((i + 1) / names.length * 30)); }

  // breadth-first expansion, so the picture grows around what you picked rather than
  // wandering off into the first branch it finds
  let frontier = [...seeds];
  for (let hop = 0; hop < depth; hop++) {
    const next = [];
    for (const n of frontier) {
      const neighbours = new Set();
      for (const f of desc[n].fields || []) if (f.type === "reference") for (const t of f.referenceTo || []) neighbours.add(t);
      for (const c of desc[n].childRelationships || []) if (c.childSObject) neighbours.add(c.childSObject);
      for (const t of neighbours) {
        if (!known.has(t) || names.includes(t)) continue;
        if (customOnly && !known.get(t).custom && !erdSel.has(t)) continue;
        if (names.length >= budget) { truncated++; continue; }
        names.push(t); next.push(t);
      }
    }
    if (!next.length) break;
    setStatus(`Expanding hop ${hop + 1}… ${names.length} objects`, "busy");
    for (let i = 0; i < next.length; i++) {
      await describe(next[i]);
      setProgress(30 + Math.round((i + 1) / next.length * 40));
    }
    frontier = next;
  }
  setProgress(75);

  const inSet = new Set(names);
  const labelOf = (n) => known.get(n)?.label || n;

  const edges = [];
  const selfRels = new Map();          // object -> [field names] drawn as a self-loop
  for (const n of names) {
    for (const f of desc[n].fields || []) {
      if (f.type !== "reference") continue;
      const targets = (f.referenceTo || []).filter(t => inSet.has(t));
      if (!targets.length) continue;
      const md = !!f.cascadeDelete || f.relationshipOrder != null;
      // a field pointing at its own object is a hierarchy — draw it as a loop on the box
      if (targets.includes(n)) {
        if (!selfRels.has(n)) selfRels.set(n, []);
        selfRels.get(n).push(f.name);
      }
      const others = targets.filter(t => t !== n);
      // WhoId / WhatId style fields hit many objects: one edge each, but labelled once
      const poly = (f.referenceTo || []).length > 1;
      for (const t of others) {
        edges.push({ from: n, to: t, field: f.name, md, poly,
                     targets: poly ? (f.referenceTo || []).length : 1 });
      }
    }
  }

  // an object whose master-detail parents are two different objects is a junction
  const mdParents = new Map();
  for (const e of edges) {
    if (!e.md) continue;
    if (!mdParents.has(e.from)) mdParents.set(e.from, new Set());
    mdParents.get(e.from).add(e.to);
  }
  const junctions = new Set([...mdParents.entries()].filter(([, s]) => s.size >= 2).map(([n]) => n));

  // dense pictures drop the field lists and shrink, otherwise nothing is readable
  const dense = names.length > 14;
  const showDetail = $("erdDetail").checked && !dense;
  const showFields = $("erdFields").checked && !dense && !showDetail;

  // key fields worth putting in a box: identity first, then external ids / required, then lookups
  const detailFor = (n) => {
    const fs = desc[n].fields || [];
    const flag = (f) => (f.unique || f.externalId || f.name === "Id") ? "🔑"
                      : (!f.nillable && f.createable) ? "*"
                      : (f.type === "reference") ? "→" : "";
    const rank = (f) => (f.name === "Id" ? 0 : f.name === "Name" ? 1
                      : (f.externalId || f.unique) ? 2
                      : (!f.nillable && f.createable) ? 3
                      : f.type === "reference" ? 4 : 5);
    return fs.filter(f => f.name !== "SystemModstamp")
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map(f => ({ name: f.name, type: f.type + (f.length && ["string","textarea"].includes(f.type) ? `(${f.length})` : ""), flag: flag(f) }));
  };
  const nodes = names.map((n, i) => {
    const rels = showFields
      ? [...new Set(edges.filter(e => e.from === n).map(e => e.field))].slice(0, 8)
      : [];
    const detail = showDetail ? detailFor(n) : [];
    const detailChars = detail.length ? Math.max(...detail.map(d => d.name.length + d.type.length + 4)) : 0;
    const chars = Math.max(labelOf(n).length, dense ? 0 : n.length, detailChars, ...rels.map(r => r.length));
    const w = dense ? Math.max(140, Math.min(220, 14 + chars * 6.6))
                    : Math.max(190, Math.min(detail.length ? 340 : 300, 10 + chars * 7.0));
    const rows = detail.length || rels.length;
    const hh = (dense ? 30 : 44) + rows * 15 + (rows ? 10 : 4);
    // seeds start in the middle, expansion rings outside — the layout settles faster
    const isSeed = erdSel.has(n);
    const ring = isSeed ? 0 : 1;
    const idx = i;
    const a = (idx / Math.max(1, names.length)) * Math.PI * 2;
    const r = ring === 0 ? 90 + names.length * 2 : 260 + names.length * 6;
    return { id: n, label: labelOf(n), seed: isSeed, rels, detail, w, h: hh,
             junction: junctions.has(n), selfRels: selfRels.get(n) || [],
             x: 520 + Math.cos(a) * r, y: 360 + Math.sin(a) * r * 0.72, vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));

  // preferred path: the layout engine. The force pass below is only the fallback.
  const elk = await erdLayout(nodes, edges, { dense, dir: $("erdDir").value });
  if (elk) {
    setProgress(null);
    setStatus("");
    const pad = 40;
    return { nodes, edges, routes: elk.routes, engine: "elk",
             w: (elk.w || Math.max(...nodes.map(n => n.x + n.w / 2))) + pad,
             h: (elk.h || Math.max(...nodes.map(n => n.y + n.h / 2))) + pad,
             seeds: seeds.length, dense, truncated, budget, depth, junctions, selfRels };
  }

  const spring = dense ? 200 : 260;
  const ticks = names.length > 30 ? 480 : 320;
  for (let step = 0; step < ticks; step++) {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        const min = (a.w + b.w) / 2 + (dense ? 34 : 60);
        if (d2 < min * min) {
          const d = Math.sqrt(d2), f = (min - d) / d * 0.2;
          a.vx += dx * f; a.vy += dy * f;
        } else {
          const f = (dense ? 3400 : 5200) / d2;
          a.vx += dx / Math.sqrt(d2) * f * 0.02;
          a.vy += dy / Math.sqrt(d2) * f * 0.02;
        }
      }
    }
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - spring) * 0.012;
      a.vx += dx / d * f; a.vy += dy / d * f;
      b.vx -= dx / d * f; b.vy -= dy / d * f;
    }
    for (const n of nodes) { n.x += (n.vx *= 0.82); n.y += (n.vy *= 0.82); }
  }

  const pad = 40;
  const minX = Math.min(...nodes.map(n => n.x - n.w / 2)), minY = Math.min(...nodes.map(n => n.y - n.h / 2));
  for (const n of nodes) { n.x -= minX - pad; n.y -= minY - pad; }
  const w = Math.max(...nodes.map(n => n.x + n.w / 2)) + pad;
  const hh2 = Math.max(...nodes.map(n => n.y + n.h / 2)) + pad;

  setProgress(null);
  setStatus("");
  return { nodes, edges, w, h: hh2, seeds: seeds.length, dense, truncated, budget, depth, junctions, selfRels };
}

// straight-ish edge between box borders, with a slight bow so parallel edges separate
function erdEdgePath(a, b, i) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.atan2(dy, dx);
  const clip = (n, sign) => {
    const hw = n.w / 2, hh = n.h / 2;
    const c = Math.cos(ang) * sign, s = Math.sin(ang) * sign;
    const tx = c ? hw / Math.abs(c) : Infinity, ty = s ? hh / Math.abs(s) : Infinity;
    const t = Math.min(tx, ty);
    return [n.x + c * t, n.y + s * t];
  };
  const [x1, y1] = clip(a, 1), [x2, y2] = clip(b, -1);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const bow = ((i % 3) - 1) * 26;
  const nx = -(y2 - y1), ny = x2 - x1;
  const len = Math.hypot(nx, ny) || 1;
  const cx = mx + nx / len * bow, cy = my + ny / len * bow;
  return { d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
           lx: cx, ly: cy };
}

function renderErd(model) {
  erdModel = model;
  const svg = $("erdSvg");
  const { nodes, edges, w, h } = model;
  const esc = escHtml;
  const routes = model.dirty ? null : model.routes;

  // points first, paths second: a hop can only be drawn once every other line is known
  const edgePts = edges.map((e, i) => {
    const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
    if (!a || !b) return null;
    const route = routes && routes.get(`e${i}`);
    if (route) return simplifyPts(route.pts);
    return model.engine === "elk" ? simplifyPts(elbowPts(a, b)) : null;   // curved fallback has no segments
  });
  const allVerticals = verticalSegs(edgePts.filter(Boolean));
  const hopsOn = $("erdHops").checked;

  const edgeSvg = edges.map((e, i) => {
    const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
    if (!a || !b) return "";
    const route = routes && routes.get(`e${i}`);
    const pts = edgePts[i];
    // an edge never hops over its own verticals, only over other edges'
    const mine = new Set(verticalSegs(pts ? [pts] : []).map(v => `${v.x}|${v.y1}|${v.y2}`));
    const others = hopsOn ? allVerticals.filter(v => !mine.has(`${v.x}|${v.y1}|${v.y2}`)) : [];
    const d = pts ? hopPath(pts, others)
                  : erdEdgePath(a, b, i).d;
    const label = e.field;
    const lp = route && route.label ? route.label
      : (model.engine === "elk" ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : erdEdgePath(a, b, i));
    const lx = lp.x ?? lp.lx, ly = lp.y ?? lp.ly;
    const labelSvg = (model.dense || !label) ? "" :
      `<rect class="elabelbg" x="${(lx - label.length * 2.8 - 3).toFixed(1)}" y="${(ly - 7).toFixed(1)}" width="${(label.length * 5.6 + 6).toFixed(1)}" height="13" rx="3"></rect>` +
      `<text class="elabel" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle">${esc(label)}</text>`;
    const many = e.md ? "erdMany" : "erdManyL";     // child side: many
    const one = e.md ? "erdOne" : "erdOneL";        // parent side: one
    const tip = `${esc(e.from)}.${esc(e.field)} → ${esc(e.to)}${e.md ? "  (master-detail)" : "  (lookup)"}${e.poly ? `  polymorphic: ${e.targets} targets` : ""}`;
    return `<path class="edge ${e.md ? "md" : "lookup"}${e.poly ? " poly" : ""}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" ` +
      `d="${d}" marker-start="url(#${many})" marker-end="url(#${one})"><title>${tip}</title></path>` + labelSvg;
  }).join("");

  const nodeSvg = nodes.map(n => {
    const x = n.x - n.w / 2, y = n.y - n.h / 2;
    const rels = n.rels.map((r, i) =>
      `<text class="fld" x="${x + 12}" y="${y + 52 + i * 15}">${esc(r)}</text>`).join("");
    const detailRows = (n.detail || []).map((f, i) => {
      const yy = y + 52 + i * 15;
      const band = i % 2 ? `<rect class="zebra" x="${x + 1}" y="${yy - 11}" width="${n.w - 2}" height="15"></rect>` : "";
      return band + `<text class="fkey" x="${x + 10}" y="${yy}">${f.flag}</text>` +
        `<text class="fld" x="${x + 24}" y="${yy}">${esc(f.name)}</text>` +
        `<text class="ftype" x="${x + n.w - 10}" y="${yy}" text-anchor="end">${esc(f.type)}</text>`;
    }).join("") + ((n.detail || []).length
      ? `<line class="sep" x1="${x + 1}" y1="${y + 38}" x2="${x + n.w - 1}" y2="${y + 38}"></line>` : "");
    // self-relationship: a small loop hooked over the top-right corner
    const loop = (n.selfRels && n.selfRels.length)
      ? `<path class="selfloop" d="M ${x + n.w - 26} ${y} c 0 -16 30 -16 30 0 c 0 12 -12 14 -16 6" ` +
        `marker-end="url(#erdOneL)"><title>${esc(n.selfRels.join(", "))} → itself (hierarchy)</title></path>`
      : "";
    const badge = n.junction
      ? `<g class="jbadge"><rect x="${x + n.w - 62}" y="${y + 6}" width="56" height="15" rx="7"></rect>` +
        `<text x="${x + n.w - 34}" y="${y + 17}" text-anchor="middle">junction</text></g>`
      : "";
    const plus = `<g class="expand" data-expand="${esc(n.id)}">` +
      `<circle cx="${x + n.w - 14}" cy="${y + n.h - 14}" r="9"></circle>` +
      `<path d="M ${x + n.w - 19} ${y + n.h - 14} h 10 M ${x + n.w - 14} ${y + n.h - 19} v 10"></path>` +
      `<title>Add this object's related objects</title></g>`;
    return `<g class="node ${n.seed ? "seed" : ""} ${n.junction ? "junction" : ""}" data-id="${esc(n.id)}" transform="translate(0,0)">` +
      `<rect class="shadow" x="${x}" y="${y + 2}" width="${n.w}" height="${n.h}" rx="10"></rect>` +
      `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="10"></rect>` +
      `<path class="hdr" d="M ${x} ${y + 10} a 10 10 0 0 1 10 -10 h ${n.w - 20} a 10 10 0 0 1 10 10 v 22 h ${-n.w} z"></path>` +
      `<line class="hdrline" x1="${x + 1}" y1="${y + 32}" x2="${x + n.w - 1}" y2="${y + 32}"></line>` +
      `<text class="title" x="${x + 12}" y="${y + 17}">${esc(n.label)}</text>` +
      `<text class="api" x="${x + 12}" y="${y + 29}">${esc(n.id)}</text>` +
      badge + loop + rels + detailRows + plus + `<title>${esc(n.label)} (${esc(n.id)})${n.junction ? " (junction object)" : ""}</title></g>`;
  }).join("");

  svg.classList.toggle("compact", !!model.dense);
  const dark = $("erdDark").checked;
  svg.classList.toggle("dark", dark);
  $("erdCanvasWrap").classList.toggle("dark", dark);
  svg.setAttribute("viewBox", `0 0 ${Math.round(w)} ${Math.round(h)}`);
  // crow's foot at the child end (many) and a bar at the parent end (one) — the
  // notation every ERD reader already knows
  const defs =
    `<defs>` +
    `<linearGradient id="erdHdr" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#f4faff"></stop><stop offset="1" stop-color="#e4f0fb"></stop></linearGradient>` +
    `<linearGradient id="erdHdrSeed" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#e8f4ff"></stop><stop offset="1" stop-color="#cfe6fb"></stop></linearGradient>` +
    `<linearGradient id="erdHdrJ" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#fff5f7"></stop><stop offset="1" stop-color="#ffe3ea"></stop></linearGradient>` +
    `<marker id="erdOne" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto">` +
      `<path d="M 10 1 L 10 11" stroke="#0b5cab" stroke-width="1.8" fill="none"></path></marker>` +
    `<marker id="erdOneL" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto">` +
      `<path d="M 10 1 L 10 11" stroke="#8fb8dd" stroke-width="1.8" fill="none"></path></marker>` +
    `<marker id="erdMany" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="11" markerHeight="11" orient="auto">` +
      `<path d="M 11 1 L 2 6 L 11 11" stroke="#0b5cab" stroke-width="1.6" fill="none"></path></marker>` +
    `<marker id="erdManyL" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="11" markerHeight="11" orient="auto">` +
      `<path d="M 11 1 L 2 6 L 11 11" stroke="#8fb8dd" stroke-width="1.6" fill="none"></path></marker>` +
    `</defs>`;
  svg.innerHTML = defs + `<g id="erdRoot">${edgeSvg}${nodeSvg}</g>`;
  erdView = { k: 1, x: 0, y: 0 };
  applyErdView();

  const md = edges.filter(e => e.md).length;
  $("erdResTitle").textContent = `${nodes.length} objects · ${edges.length} relationships`;
  $("erdResNote").innerHTML =
    (model.truncated
      ? `<b>${model.truncated} related object${model.truncated === 1 ? "" : "s"} left out</b> to stay inside the ${model.budget}-box budget. Raise it or reduce the hops for more. `
      : "") +
    (model.dense ? "Dense diagram: field lists and edge labels are hidden so the boxes stay readable. " : "") +
    (model.restored ? "Your saved arrangement for these objects was restored. Press Tidy layout for a fresh one. "
                    : (model.engine === "elk" ? "Layered layout with right-angle routing. " : "Fallback layout (engine unavailable). ")) +
    "Drag a box to move it, scroll to zoom, drag the background to pan, then Tidy layout to re-route." +
    `<div class="erdlegend"><span><i></i> master-detail</span><span><i class="dash"></i> lookup</span>` +
    `<span>crow's foot = many, bar = one</span><span>blue border = object you picked</span>` +
    `<span>loop = self-relationship</span>` +
    ((nodes[0] && (nodes[0].detail || []).length) ? `<span>🔑 unique / external id · * required · → lookup</span>` : "") +
    `</div>`;
  const junctionCount = nodes.filter(n => n.junction).length;
  const selfCount = nodes.filter(n => (n.selfRels || []).length).length;
  $("erdResSummary").innerHTML =
    `<span class="r">${nodes.length} objects</span><span class="r">${md} master-detail</span>` +
    `<span class="r">${edges.length - md} lookups</span>` +
    (junctionCount ? `<span class="e">${junctionCount} junction${junctionCount === 1 ? "" : "s"}</span>` : "") +
    (selfCount ? `<span class="r">${selfCount} self-relationship${selfCount === 1 ? "" : "s"}</span>` : "");
  flashBox("erdResult");
}

// Positions before the current drag, so a nudge you did not want is one key away.
let erdUndo = [];

function erdPushUndo() {
  if (!erdModel) return;
  erdUndo.push(erdModel.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })));
  if (erdUndo.length > 40) erdUndo.shift();
}

function erdUndoMove() {
  const prev = erdUndo.pop();
  if (!prev || !erdModel) return setStatus("Nothing to undo.", "err");
  for (const p of prev) {
    const n = erdModel.nodes.find(x => x.id === p.id);
    if (n) { n.x = p.x; n.y = p.y; }
  }
  erdModel.dirty = true;
  renderErdKeepView();
  setStatus(`Undone. ${erdUndo.length} step${erdUndo.length === 1 ? "" : "s"} left.`, "ok");
}

// Tints matching boxes rather than hiding the rest: on a big canvas you still want the
// shape of the diagram around whatever you searched for.
function erdFindHighlight() {
  const term = $("erdFind").value.trim().toLowerCase();
  const svg = $("erdSvg");
  let hits = 0;
  svg.querySelectorAll(".node").forEach(g => {
    const id = (g.dataset.id || "").toLowerCase();
    const label = (g.querySelector(".title")?.textContent || "").toLowerCase();
    const on = !!term && (id.includes(term) || label.includes(term));
    g.classList.toggle("hit", on);
    if (on) hits++;
  });
  if (term) setStatus(hits ? `${hits} object${hits === 1 ? "" : "s"} matched.` : "No object matches that.", hits ? "ok" : "err");
  else setStatus("");
}

function applyErdView() {
  const root = document.getElementById("erdRoot");
  if (root) root.setAttribute("transform", `translate(${erdView.x} ${erdView.y}) scale(${erdView.k})`);
}

// --- interactions: drag nodes, pan background, wheel zoom ---
function wireErdCanvas() {
  const svg = $("erdSvg");
  let mode = null, startX = 0, startY = 0, node = null, nodeStart = null;

  const svgPoint = (ev) => {
    const r = svg.getBoundingClientRect();
    const vb = (svg.getAttribute("viewBox") || "0 0 1 1").split(" ").map(Number);
    const sx = vb[2] / r.width, sy = vb[3] / r.height;
    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
  };

  svg.addEventListener("click", (ev) => {
    const ex = ev.target.closest("[data-expand]");
    if (ex) { ev.stopPropagation(); erdExpandNode(ex.dataset.expand); }
  });
  svg.addEventListener("mouseover", (ev) => {
    const g = ev.target.closest(".node");
    if (g) erdFocus(g.dataset.id);
  });
  svg.addEventListener("mouseleave", () => erdFocus(null));

  svg.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("[data-expand]")) return;      // the + handle is a click, not a drag
    const g = ev.target.closest(".node");
    const p = svgPoint(ev);
    startX = p.x; startY = p.y;
    if (g && erdModel) {
      mode = "node";
      erdPushUndo();                                     // snapshot before the box moves
      node = erdModel.nodes.find(n => n.id === g.dataset.id);
      nodeStart = node ? { x: node.x, y: node.y } : null;
    } else {
      mode = "pan";
      nodeStart = { x: erdView.x, y: erdView.y };
      svg.classList.add("dragging");
    }
    svg.setPointerCapture(ev.pointerId);
  });

  svg.addEventListener("pointermove", (ev) => {
    if (!mode) return;
    const p = svgPoint(ev);
    const dx = (p.x - startX), dy = (p.y - startY);
    if (mode === "node" && node && nodeStart) {
      node.x = nodeStart.x + dx / erdView.k;
      node.y = nodeStart.y + dy / erdView.k;
      erdModel.dirty = true;
      renderErdKeepView();
      saveErdLayout();
    } else if (mode === "pan" && nodeStart) {
      erdView.x = nodeStart.x + dx;
      erdView.y = nodeStart.y + dy;
      applyErdView();
    }
  });

  const end = (ev) => {
    mode = null; node = null; nodeStart = null;
    svg.classList.remove("dragging");
    try { svg.releasePointerCapture(ev.pointerId); } catch {}
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  svg.addEventListener("wheel", (ev) => {
    if (!erdModel) return;
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    erdView.k = Math.max(0.35, Math.min(3, erdView.k * factor));
    applyErdView();
  }, { passive: false });
}

// redraw after a node move without resetting zoom/pan
function renderErdKeepView() {
  const keep = { ...erdView };
  renderErd(erdModel);
  erdView = keep;
  applyErdView();
}

async function erdRelayout() {
  const btn = $("erdRelayoutBtn");
  btn.disabled = true;
  try {
    if (!erdModel) throw new Error("Draw a diagram first.");
    setStatus("Tidying layout…", "busy");
    const elk = await erdLayout(erdModel.nodes, erdModel.edges, { dense: erdModel.dense, dir: $("erdDir").value });
    if (!elk) throw new Error("Layout engine unavailable.");
    const pad = 40;
    erdModel.routes = elk.routes;
    erdModel.dirty = false;
    erdModel.engine = "elk";
    erdModel.w = (elk.w || erdModel.w) + pad;
    erdModel.h = (elk.h || erdModel.h) + pad;
    renderErd(erdModel);
    saveErdLayout();
    setStatus("");
  } catch (err) {
    setStatus(`Tidy failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

async function erdDraw() {
  const btn = $("erdDrawBtn");
  btn.disabled = true;
  try {
    const model = await buildErdModel();
    const saved = await loadErdLayout();
    if (saved) {
      let hits = 0;
      for (const n of model.nodes) if (saved[n.id]) { [n.x, n.y] = saved[n.id]; hits++; }
      if (hits === model.nodes.length) { model.dirty = true; model.restored = true; }
    }
    renderErd(model);
    saveErdLayout();
  }
  catch (err) { setProgress(null); setStatus(`Diagram failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

// standalone SVG file: inline the styles so it opens correctly anywhere
function erdStandaloneSvg() {
  if (!erdModel) throw new Error("Draw the diagram first.");
  const svg = $("erdSvg");
  const dark = $("erdDark").checked;
  const P = dark
    ? { bg: "#0e1726", box: "#16223a", boxStroke: "#33507a", seed: "#4da3ea", hdr: "#1d2d4a", seedHdr: "#24406b",
        title: "#cfe4fa", api: "#8fa2bd", fld: "#c3d3ea", ftype: "#7f93b3", edge: "#6f9dcb", md: "#7db8ee",
        label: "#9fb4d0", labelBg: "#0e1726", sep: "#2a3b5c", junction: "#e5636f", junctionHdr: "#3a1c26", sub: "#9fb4d0" }
    : { bg: "#ffffff", box: "#ffffff", boxStroke: "#cfe6fb", seed: "#0176d3", hdr: "#eaf3fc", seedHdr: "#d8ebfb",
        title: "#0b3d68", api: "#5b6b83", fld: "#33415c", ftype: "#7b8ba3", edge: "#8fb8dd", md: "#0b5cab",
        label: "#5b6b83", labelBg: "#ffffff", sep: "#e5eaf1", junction: "#b0335a", junctionHdr: "#ffeff2", sub: "#5b6b83" };
  const css = `
    .node rect { fill:${P.box}; stroke:${P.boxStroke}; stroke-width:1.5 }
    .node.seed rect { stroke:${P.seed}; stroke-width:2 }
    .node .hdr { fill:${P.hdr} } .node.seed .hdr { fill:${P.seedHdr} }
    .node.junction rect { stroke:${P.junction} } .node.junction .hdr { fill:${P.junctionHdr} }
    .jbadge rect { fill:${P.junction}; stroke:none } .jbadge text { font-size:9px; font-weight:700; fill:#fff }
    text { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif }
    .title { font-size:12.5px; font-weight:700; fill:${P.title} }
    .api { font-size:10px; fill:${P.api}; font-family: Consolas, monospace }
    .fld { font-size:10.5px; fill:${P.fld}; font-family: Consolas, monospace }
    .ftype { font-size:9.5px; fill:${P.ftype}; font-family: Consolas, monospace }
    .fkey { font-size:9.5px }
    .sep { stroke:${P.sep}; stroke-width:1 }
    .edge { fill:none; stroke:${P.edge}; stroke-width:1.6 }
    .edge.md { stroke:${P.md}; stroke-width:2.2 } .edge.lookup { stroke-dasharray:6 4 }
    .edge.poly { stroke-dasharray:2 3 }
    .selfloop { fill:none; stroke:${P.edge}; stroke-width:1.6 }
    .elabel { font-size:9.5px; fill:${P.label}; font-family: Consolas, monospace }
    .elabelbg { fill:${P.labelBg}; opacity:.85 }`;
  const band = 62;                                  // title block above the drawing
  // The layout's own width and height stop being true the moment a box is dragged, and they
  // never included edge labels or the self-relationship loops, so exports were cropped.
  // Measuring the drawn content is exact: getBBox covers every rendered child.
  const pad = 24;
  let box = null;
  try {
    const root = document.getElementById("erdRoot");
    const bb = root && root.getBBox();
    if (bb && bb.width > 1 && bb.height > 1) box = bb;
  } catch (e) { console.warn("bbox unavailable, falling back to layout size:", e); }
  const W = Math.round(box ? box.width + pad * 2 : erdModel.w);
  const H = Math.round(box ? box.height + pad * 2 : erdModel.h) + band;
  // shift the drawing so its top-left lands just inside the padding
  const shiftX = box ? Math.round(pad - box.x) : 0;
  const shiftY = box ? Math.round(pad - box.y) : 0;
  const md = erdModel.edges.filter(e => e.md).length;
  const junctions = erdModel.nodes.filter(n => n.junction).length;
  const title = `Schema diagram · ${hostOf(auth)}`;
  const sub = `${erdModel.nodes.length} objects · ${md} master-detail · ${erdModel.edges.length - md} lookups` +
    (junctions ? ` · ${junctions} junction${junctions === 1 ? "" : "s"}` : "") + ` · ${today()}`;
  const legend =
    `<g transform="translate(${Math.max(24, W - 330)} 18)">` +
    `<line x1="0" y1="10" x2="26" y2="10" stroke="${P.md}" stroke-width="2.2"></line>` +
    `<text x="32" y="14" class="lg">master-detail</text>` +
    `<line x1="120" y1="10" x2="146" y2="10" stroke="${P.edge}" stroke-width="1.6" stroke-dasharray="6 4"></line>` +
    `<text x="152" y="14" class="lg">lookup</text>` +
    `<text x="0" y="34" class="lg">crow's foot = many · bar = one · loop = self-relationship</text>` +
    `</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<style>${css} .ttl{font-size:15px;font-weight:700;fill:${P.title}} .sub{font-size:11px;fill:${P.sub}} .lg{font-size:10px;fill:${P.sub}}</style>` +
    `<rect width="100%" height="100%" fill="${P.bg}"></rect>` +
    `<text class="ttl" x="24" y="28">${escHtml(title)}</text>` +
    `<text class="sub" x="24" y="46">${escHtml(sub)}</text>` +
    legend +
    `<line x1="0" y1="${band - 1}" x2="${W}" y2="${band - 1}" stroke="${P.sep}"></line>` +
    `<g transform="translate(${shiftX} ${band + shiftY})">` +
    svg.innerHTML.replace(/transform="translate\([^)]*\) scale\([^)]*\)"/, "") +
    `</g></svg>`;
}

function erdExportSvg() {
  try {
    const xml = erdStandaloneSvg();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    a.download = `${hostOf(auth)}_schema_${today()}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("SVG exported.", "ok");
  } catch (err) { setStatus(err.message, "err"); }
}


// PDF: hand the standalone SVG to the browser's print pipeline, which produces a true
// vector PDF via "Save as PDF" — better quality than rasterising, and no extra library.
function erdExportPdf() {
  try {
    const xml = erdStandaloneSvg();
    const dims = xml.match(/viewBox="0 0 (\d+) (\d+)"/);
    const landscape = dims ? Number(dims[1]) >= Number(dims[2]) : erdModel.w >= erdModel.h;
    const win = window.open("", "_blank");
    if (!win) { setStatus("Popup blocked. Allow popups for this page to export PDF.", "err"); return; }
    win.document.write(
      `<!doctype html><html><head><title>Schema diagram · ${escHtml(hostOf(auth))}</title>` +
      `<style>@page { size: A3 ${landscape ? "landscape" : "portrait"}; margin: 10mm; }` +
      `html,body{margin:0;padding:0;background:#fff}` +
      `svg{max-width:100%;max-height:100vh;width:auto;height:auto;display:block;margin:0 auto}</style></head>` +
      `<body>${xml}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { try { win.print(); } catch {} }, 350);
    setStatus("Print dialog opened. Choose “Save as PDF”.", "ok");
  } catch (err) { setStatus(err.message, "err"); }
}

function erdExportPng() {
  try {
    const xml = erdStandaloneSvg();
    // the canvas must match the SVG that was actually produced, or the image is cropped
    const dims = xml.match(/viewBox="0 0 (\d+) (\d+)"/);
    const svgW = dims ? Number(dims[1]) : Math.round(erdModel.w);
    const svgH = dims ? Number(dims[2]) : Math.round(erdModel.h + 62);
    // keep the longest side under 8000px: past that some browsers refuse to rasterise
    const scale = Math.max(1, Math.min(2, 8000 / Math.max(svgW, svgH)));
    const img = new Image();
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(svgW * scale);
      c.height = Math.round(svgH * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = $("erdDark").checked ? "#0e1726" : "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${hostOf(auth)}_schema_${today()}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
        setStatus("PNG exported.", "ok");
      }, "image/png");
    };
    img.onerror = () => setStatus("PNG export failed. Use Export SVG instead.", "err");
    img.src = url;
  } catch (err) { setStatus(err.message, "err"); }
}


// ---------- Code browse: list every source file, open one to read it ----------
let codeFiles = [];

async function listCodeFiles() {
  const sources = CODE_SOURCES();
  if (!sources.length) throw new Error("Tick at least one source type.");
  const files = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    setProgress(Math.round(i / sources.length * 100));
    setStatus(`Listing ${s.type}…`, "busy");
    // list first without the body, so a big org stays fast
    const strip = (q) => q.replace(/,\s*(Body|Markup|Source)\b/i, "");
    let recs;
    try {
      try { recs = await (s.std ? stdQuery(strip(s.soql)) : toolingQuery(strip(s.soql))); }
      catch (inner) {
        if (!s.alt) throw inner;
        recs = await (s.std ? stdQuery(strip(s.alt)) : toolingQuery(strip(s.alt)));
      }
    }
    catch (e) { files.push({ name: `(could not list ${s.type})`, type: s.type, api: "", lines: "", chars: String(e.message), src: null }); continue; }
    for (const r of recs) {
      files.push({ name: s.name(r), type: s.type, api: r.ApiVersion ?? "",
                   lines: "", chars: r.LengthWithoutComments ?? "", rec: r, spec: s,
                   bundle: s.bundle ? s.bundle(r) : null, part: s.part ? s.part(r) : null });
    }
  }
  setProgress(null);
  setStatus("");
  codeFiles = files;
  return files;
}

function renderCodeList() {
  const q = $("codeListFilter").value.trim().toLowerCase();
  const list = q ? codeFiles.filter(f => f.name.toLowerCase().includes(q) || f.type.toLowerCase().includes(q)) : codeFiles;
  $("codeListBody").innerHTML = list.slice(0, 800).map((f, i) =>
    `<tr class="objrow" data-file="${codeFiles.indexOf(f)}"><td>${hl(f.name, q)}</td><td>${escHtml(f.type)}</td>` +
    `<td>${escHtml(String(f.api))}</td><td>${escHtml(String(f.lines))}</td><td>${escHtml(String(f.chars))}</td></tr>`).join("")
    || `<tr><td colspan="5" style="color:var(--faint);">Nothing matches.</td></tr>`;
  const byType = {};
  for (const f of list) byType[f.type] = (byType[f.type] || 0) + 1;
  $("codeListSummary").innerHTML = Object.entries(byType).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="r">${n} ${escHtml(t)}</span>`).join("") || `<span class="n">nothing listed</span>`;
}

async function codeList() {
  const btn = $("codeListBtn");
  btn.disabled = true;
  try {
    const files = await listCodeFiles();
    $("codeListTitle").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
    $("codeListNote").textContent = "Click a row to read its source. Managed-package code cannot be read and shows as unavailable.";
    $("codeListFilter").value = "";
    $("codeViewer").style.display = "none";
    renderCodeList();
    flashBox("codeListResult");
  } catch (err) {
    setProgress(null);
    setStatus(`Listing failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// A bundle is several files, so opening one of them opens all of them: an LWC is its
// html, js, css and js-meta.xml, and reading only the file you clicked hides most of the
// component. Bodies are still fetched per bundle, never for the whole org.
let codeBundleFiles = [], codeBundleIdx = 0, codeBundleOwner = null;

// LWC's own order, which is how a developer reads a component
const LWC_ORDER = [".js", ".html", ".css", ".js-meta.xml", ".svg", ".test.js"];
function partRank(part) {
  const i = LWC_ORDER.findIndex(ext => String(part).endsWith(ext));
  return i < 0 ? 99 : i;
}

async function openCodeFile(idx) {
  const f = codeFiles[Number(idx)];
  if (!f || !f.spec) return;
  try {
    setStatus(`Opening ${f.name}…`, "busy");
    const s = f.spec, r = f.rec;

    if (s.siblings && f.bundle) {
      // the whole bundle in one query, tabs in reading order
      const recs = await toolingQuery(s.siblings(f.bundle));
      codeBundleFiles = recs
        .map(rec => ({ part: s.sibPart(rec), body: rec.Source, id: rec.Id }))
        .sort((a, b) => partRank(a.part) - partRank(b.part) || String(a.part).localeCompare(String(b.part)));
      codeBundleIdx = Math.max(0, codeBundleFiles.findIndex(x => x.part === f.part));
      codeBundleOwner = f;
      setStatus("");
      renderCodeBundle(f);
      $("codeViewer").style.display = "block";
      $("codeViewer").scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    let body = r[s.text];
    if (typeof body !== "string") {
      // re-query just this record, now including the text column
      const idField = r.Id ? `Id = '${r.Id}'` : null;
      let recs = [];
      if (idField) {
        const q = s.soql.replace(/\s+WHERE\s+.*$/i, "") + ` WHERE ${idField} LIMIT 1`;
        recs = await (s.std ? stdQuery(q) : toolingQuery(q));
      }
      body = recs[0]?.[s.text];
    }
    setStatus("");
    codeBundleFiles = [];
    $("codeTabs").style.display = "none";
    if (typeof body !== "string" || !body || body.startsWith("(hidden)")) {
      $("codeViewTitle").textContent = `${f.name} (source unavailable)`;
      $("codeViewBody").textContent = "This component's source is not readable (managed package, or the field was not returned).";
    } else {
      const lines = body.split(/\r?\n/);
      f.lines = lines.length;
      $("codeViewTitle").textContent = `${f.name} · ${f.type} · ${lines.length} lines`;
      $("codeViewBody").textContent = body;
      renderCodeList();
    }
    $("codeViewer").style.display = "block";
    $("codeViewer").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    setStatus(`Could not open source: ${err.message}`, "err");
  }
}

function renderCodeBundle(f) {
  const cur = codeBundleFiles[codeBundleIdx];
  $("codeTabs").innerHTML = codeBundleFiles.map((x, i) => {
    const dot = String(x.part).indexOf(".");
    const stem = dot > 0 ? String(x.part).slice(0, dot) : x.part;
    const ext = dot > 0 ? String(x.part).slice(dot) : "";
    return `<button class="${i === codeBundleIdx ? "on" : ""}" data-tab="${i}">` +
      `${escHtml(stem)}<span class="ext">${escHtml(ext)}</span></button>`;
  }).join("");
  $("codeTabs").style.display = codeBundleFiles.length > 1 ? "flex" : "none";
  const body = cur?.body;
  const lines = typeof body === "string" ? body.split(/\r?\n/).length : 0;
  const total = codeBundleFiles.reduce((n, x) => n + (typeof x.body === "string" ? x.body.split(/\r?\n/).length : 0), 0);
  $("codeViewTitle").textContent = `${f.bundle} · ${f.type} · ${codeBundleFiles.length} files, ${total} lines total` +
    (cur ? ` · showing ${cur.part} (${lines} lines)` : "");
  $("codeViewBody").textContent = typeof body === "string" && body
    ? body : "This file is empty, or its source was not returned.";
}

// ---------- Code search: grep across source bodies ----------
let codeHits = [], codeTermUsed = "";
let codeSources = [];        // [{name, type, body}] kept from the last search

// each source: a query, the field holding the text, and how to name the component
const CODE_SOURCES = () => {
  const list = [];
  if ($("codeApex").checked) {
    list.push({ type: "Apex Class", std: true, soql: "SELECT Id, Name, ApiVersion, LengthWithoutComments, NamespacePrefix, Body FROM ApexClass WHERE NamespacePrefix = null", text: "Body", name: r => r.Name });
    list.push({ type: "Apex Trigger", std: true, soql: "SELECT Id, Name, ApiVersion, LengthWithoutComments, NamespacePrefix, Body FROM ApexTrigger WHERE NamespacePrefix = null", text: "Body", name: r => r.Name });
  }
  if ($("codeVf").checked) {
    list.push({ type: "Visualforce Page", std: true, soql: "SELECT Id, Name, ApiVersion, NamespacePrefix, Markup FROM ApexPage WHERE NamespacePrefix = null", text: "Markup", name: r => r.Name });
    list.push({ type: "Visualforce Component", std: true, soql: "SELECT Id, Name, ApiVersion, NamespacePrefix, Markup FROM ApexComponent WHERE NamespacePrefix = null", text: "Markup", name: r => r.Name });
  }
  if ($("codeLwc").checked) {
    list.push({ type: "LWC",
      soql: "SELECT Id, FilePath, Source, LightningComponentBundle.DeveloperName FROM LightningComponentResource " +
            "WHERE LightningComponentBundle.NamespacePrefix = null",
      alt: "SELECT Id, FilePath, Source, LightningComponentBundle.DeveloperName FROM LightningComponentResource",
      text: "Source",
      name: r => `${r.LightningComponentBundle?.DeveloperName || "?"} / ${(r.FilePath || "").split("/").pop()}`,
      bundle: r => r.LightningComponentBundle?.DeveloperName || null,
      part: r => (r.FilePath || "").split("/").pop() || "file",
      // every resource of one bundle, so opening any file offers the whole bundle
      siblings: (name) => "SELECT Id, FilePath, Source FROM LightningComponentResource " +
        `WHERE LightningComponentBundle.DeveloperName = '${name.replace(/'/g, "")}'`,
      sibPart: r => (r.FilePath || "").split("/").pop() || "file" });
  }
  if ($("codeAura").checked) {
    list.push({ type: "Aura",
      soql: "SELECT Id, Source, DefType, AuraDefinitionBundle.DeveloperName FROM AuraDefinition " +
            "WHERE AuraDefinitionBundle.NamespacePrefix = null",
      alt: "SELECT Id, Source, DefType, AuraDefinitionBundle.DeveloperName FROM AuraDefinition",
      text: "Source",
      name: r => `${r.AuraDefinitionBundle?.DeveloperName || "?"} (${r.DefType})`,
      bundle: r => r.AuraDefinitionBundle?.DeveloperName || null,
      part: r => r.DefType || "definition",
      siblings: (name) => "SELECT Id, Source, DefType FROM AuraDefinition " +
        `WHERE AuraDefinitionBundle.DeveloperName = '${name.replace(/'/g, "")}'`,
      sibPart: r => r.DefType || "definition" });
  }
  return list;
};

async function runCodeSearch() {
  const term = $("codeTerm").value.trim();
  if (term.length < 3) throw new Error("Use at least 3 characters, since shorter terms match almost everything.");
  const sources = CODE_SOURCES();
  if (!sources.length) throw new Error("Tick at least one source type.");
  const cased = $("codeCase").checked;
  const needle = cased ? term : term.toLowerCase();
  const hits = [];
  codeSources = [];
  const srcIndex = new Map();
  let scanned = 0, skipped = 0;

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    setProgress(Math.round(i / sources.length * 100));
    setStatus(`Searching ${s.type}…` + (s.type === "LWC" || s.type === "Aura"
      ? " (component sources are large, this is the slow part)" : ""), "busy");
    let recs;
    const runQuery = (q) => (s.std ? stdQuery(q) : toolingQuery(q));
    try {
      try { recs = await runQuery(s.soql); }
      catch (inner) {
        if (!s.alt) throw inner;
        recs = await runQuery(s.alt);          // this org rejects the namespace filter
      }
    }
    catch (e) { hits.push({ name: "(could not read " + s.type + ")", type: s.type, line: "", code: String(e.message) }); continue; }
    for (const r of recs) {
      const body = r[s.text];
      if (typeof body !== "string" || !body) { skipped++; continue; }   // managed code reads as (hidden)
      if (body.startsWith("(hidden)")) { skipped++; continue; }
      scanned++;
      const lines = body.split(/\r?\n/);
      for (let n = 0; n < lines.length; n++) {
        const hay = cased ? lines[n] : lines[n].toLowerCase();
        if (hay.includes(needle)) {
          // the body is already in hand from the grep, so the click that opens it later
          // costs nothing: one entry per component, referenced by index from every hit
          let srcIdx = srcIndex.get(r.Id || s.name(r));
          if (srcIdx === undefined) {
            srcIdx = codeSources.push({ name: s.name(r), type: s.type, body }) - 1;
            srcIndex.set(r.Id || s.name(r), srcIdx);
          }
          hits.push({ name: s.name(r), type: s.type, line: n + 1, code: lines[n].trim().slice(0, 300), src: srcIdx });
          if (hits.length > 3000) break;
        }
      }
      if (hits.length > 3000) break;
    }
  }
  setProgress(null);
  setStatus("");
  codeHits = hits; codeTermUsed = term;
  return { hits, scanned, skipped, term };
}

function renderCodeCard(res) {
  const files = new Set(res.hits.map(x => `${x.type}|${x.name}`)).size;
  $("codeResTitle").textContent = `“${res.term}”`;
  $("codeResNote").textContent = res.hits.length
    ? `${res.hits.length} match${res.hits.length === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}, searched ${res.scanned} source file${res.scanned === 1 ? "" : "s"}.` +
      (res.skipped ? ` ${res.skipped} skipped (managed package source is not readable).` : "")
    : `No matches in ${res.scanned} source file${res.scanned === 1 ? "" : "s"}.` +
      (res.skipped ? ` ${res.skipped} skipped (managed package source is not readable).` : "");
  const byType = {};
  for (const x of res.hits) byType[x.type] = (byType[x.type] || 0) + 1;
  $("codeResSummary").innerHTML = Object.entries(byType).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="r">${n} in ${escHtml(t)}</span>`).join("") || `<span class="n">no matches</span>`;
  $("codeResList").innerHTML = res.hits.slice(0, 500).map((x, i) =>
    `<tr class="${x.src == null ? "" : "objrow"}" ${x.src == null ? "" : `data-hit="${i}"`}>` +
    `<td>${escHtml(x.name)}</td><td>${escHtml(x.type)}</td><td>${x.line}</td>` +
    `<td class="mono">${hl(x.code, res.term)}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:var(--faint);">Nothing to show.</td></tr>`;
  $("codeResNote").textContent += " Click a row to read the file, with the matching line marked.";
  if (res.hits.length > 500) $("codeResNote").textContent += ` Showing the first 500.`;
  flashBox("codeResult");
}

// A search result is only half an answer: the line matters in context. Clicking a hit shows
// the whole file from the body already fetched, with every matching line marked and the
// clicked one scrolled to.
function openCodeHit(idx) {
  const hit = codeHits[Number(idx)];
  if (!hit || hit.src == null) return;
  const src = codeSources[hit.src];
  if (!src) return;
  const lines = String(src.body).split(/\r?\n/);
  const term = codeTermUsed;
  const cased = $("codeCase").checked;
  const needle = cased ? term : term.toLowerCase();
  const width = String(lines.length).length;

  $("codeHitTitle").textContent = `${src.name} · ${src.type} · line ${hit.line} of ${lines.length}`;
  $("codeHitBody").innerHTML = lines.map((ln, i) => {
    const hay = cased ? ln : ln.toLowerCase();
    const isHit = needle && hay.includes(needle);
    const num = String(i + 1).padStart(width, " ");
    const cls = i + 1 === hit.line ? "ln here" : isHit ? "ln hit" : "ln";
    return `<div class="${cls}" ${i + 1 === hit.line ? 'id="codeHitHere"' : ""}>` +
      `<span class="no">${num}</span><span class="src">${isHit ? hl(ln, term) : escHtml(ln)}</span></div>`;
  }).join("");
  $("codeHitBox").style.display = "block";
  flashBox("codeHitBox");
  const here = document.getElementById("codeHitHere");
  if (here) here.scrollIntoView({ block: "center" });
}

async function codeSearch() {
  const btn = $("codeSearchBtn");
  btn.disabled = true;
  try { renderCodeCard(await runCodeSearch()); }
  catch (err) { setProgress(null); setStatus(`Code search failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function codeExport() {
  const btn = $("codeExportBtn");
  btn.disabled = true;
  try {
    const res = await runCodeSearch();
    renderCodeCard(res);
    if (!res.hits.length) throw new Error("No matches to export.");
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Component", "Type", "Line", "Code"],
      ...res.hits.map(x => [x.name, x.type, x.line, x.code])], "Matches", 80);
    const byFile = new Map();
    for (const x of res.hits) {
      const k = `${x.type}|${x.name}`;
      byFile.set(k, (byFile.get(k) || 0) + 1);
    }
    sheetFromRows(wb, [["Type", "Component", "Matches"],
      ...[...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k.split("|")[0], k.split("|")[1], n])], "By File");
    sheetFromRows(wb, [["Search term", res.term], ["Files searched", res.scanned],
      ["Skipped (managed)", res.skipped], ["Matches", res.hits.length], ["Run", today()]], "About");
    XLSX.writeFile(wb, `${hostOf(auth)}_code_search_${today()}.xlsx`);
    setStatus(`Exported ${res.hits.length} matches.`, "ok");
  } catch (err) {
    setProgress(null);
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- SOQL query (read-only) ----------
let soqlRows = [], soqlCols = [], soqlQuery = "";

// records come back nested (Owner.Name -> {Owner:{Name}}), so flatten to dotted keys
function flattenRecord(rec, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !("totalSize" in v)) flattenRecord(v, key, out);
    else if (v && typeof v === "object") out[key] = "(sub-query, export to see rows)";
    else out[key] = v;
  }
  return out;
}

async function runSoql() {
  const raw = $("soqlText").value.trim();
  if (!raw) throw new Error("Type a query first.");
  if (!/^\s*select\b/i.test(raw)) throw new Error("Only SELECT queries can run here.");
  const tooling = $("soqlTooling").checked;
  const all = $("soqlAll").checked;
  const base = tooling ? "/tooling/query/?q=" : "/query/?q=";
  setStatus("Running query…", "busy");
  let path = base + encodeURIComponent(raw);
  const records = [];
  while (path) {
    const r = await api(path);
    records.push(...(r.records || []));
    setStatus(`Running query… ${records.length} row${records.length === 1 ? "" : "s"}`, "busy");
    path = (all && r.nextRecordsUrl) ? r.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, "") : null;
  }
  const flat = records.map(r => flattenRecord(r));
  const cols = [];
  for (const row of flat) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  soqlRows = flat; soqlCols = cols; soqlQuery = raw;
  setStatus("");
  return { flat, cols, raw };
}

function renderSoqlCard() {
  $("soqlResTitle").textContent = `${soqlRows.length} row${soqlRows.length === 1 ? "" : "s"}`;
  $("soqlResNote").textContent = soqlRows.length
    ? ($("soqlAll").checked ? "All pages fetched." : "First batch only. Tick “Fetch all pages” for the rest.")
    : "The query ran and returned no rows.";
  $("soqlResSummary").innerHTML =
    `<span class="r">${soqlCols.length} column${soqlCols.length === 1 ? "" : "s"}</span>` +
    `<span class="r">${$("soqlTooling").checked ? "Tooling API" : "Data API"}</span>`;
  $("soqlResHead").innerHTML = `<tr>${soqlCols.map(c => `<th>${escHtml(c)}</th>`).join("")}</tr>`;
  $("soqlResList").innerHTML = soqlRows.slice(0, 500).map(r =>
    `<tr>${soqlCols.map(c => `<td>${escHtml(r[c] ?? "")}</td>`).join("")}</tr>`).join("")
    || `<tr><td colspan="${Math.max(1, soqlCols.length)}" style="color:var(--faint);">No rows.</td></tr>`;
  if (soqlRows.length > 500) $("soqlResNote").textContent += ` Showing the first 500 of ${soqlRows.length} rows.`;
  flashBox("soqlResult");
}

async function soqlRun() {
  const btn = $("soqlRunBtn");
  btn.disabled = true;
  try { await runSoql(); renderSoqlCard(); }
  catch (err) { setStatus(`Query failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function soqlExport() {
  const btn = $("soqlExportBtn");
  btn.disabled = true;
  try {
    if (!soqlRows.length) await runSoql();
    renderSoqlCard();
    if (!soqlRows.length) throw new Error("Nothing to export, the query returned no rows.");
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [soqlCols, ...soqlRows.map(r => soqlCols.map(c => r[c] ?? ""))], "Rows", 50);
    sheetFromRows(wb, [["Query"], [soqlQuery], [], ["API", $("soqlTooling").checked ? "Tooling" : "Data"], ["Rows", soqlRows.length], ["Run", today()]], "About");
    XLSX.writeFile(wb, `${hostOf(auth)}_soql_${today()}.xlsx`);
    setStatus(`Exported ${soqlRows.length} rows.`, "ok");
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- Schema export ----------
async function exportSchema() {
  const btn = $("exportBtn");
  btn.disabled = true;
  $("bar").style.display = "block";
  try {
    setStatus("Listing objects…", "busy");
    let objs = await loadObjectList();
    if ($("pickObjects").checked) {
      objs = objs.filter(s => selectedObjs.has(s.name));
      if (!objs.length) throw new Error("No objects selected, tick some in the list.");
    } else if ($("customOnly").checked) {
      objs = objs.filter(s => s.custom);
    }

    const describes = {};
    let done = 0;
    const queue = objs.map(s => s.name);
    async function worker() {
      while (queue.length) {
        const name = queue.shift();
        try { describes[name] = await api(`/sobjects/${name}/describe/`); }
        catch (e) { console.warn("describe failed", name, e); }
        done++;
        $("barFill").style.width = `${Math.round(done / objs.length * 100)}%`;
        setStatus(`Describing objects… ${done}/${objs.length}`, "busy");
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    setStatus("Building workbook…", "busy");
    const wb = XLSX.utils.book_new();
    const { names, totalFields } = buildCoreSheets(wb, describes, $("includePK").checked);
    if ($("includeVR").checked) {
      const vrRows = await fetchVRRows(new Set(names));
      if (vrRows) sheetFromRows(wb, vrRows, "Validation Rules", 60);
    }
    if ($("includeCode").checked) {
      const codeRows = await collectCodeRows();
      sheetFromRows(wb, codeRows.length > 1 ? codeRows : [...codeRows, ["(no code found)","","","","","","",""]], "Code Inventory", 50);
    }

    const host = new URL(auth.instanceUrl).hostname.split(".")[0];
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${host}_schema_${stamp}.xlsx`);
    setStatus(`Done, ${names.length} objects, ${totalFields} fields exported.`, "ok");
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
    $("bar").style.display = "none";
    $("barFill").style.width = "0%";
  }
}

// shared: Objects/Fields/Record Types/Relationships/Picklists sheets from a describes map
function buildCoreSheets(wb, describes, withPicklists) {
  const names = Object.keys(describes).sort();

  const objRows = [["Object Label","API Name","Custom","Key Prefix","Field Count","Record Types","Createable","Updateable","Deletable","Feed Enabled"]];
    for (const n of names) {
      const d = describes[n];
      objRows.push([d.label, n, d.custom ? "Yes" : "No", d.keyPrefix || "",
        (d.fields || []).length, (d.recordTypeInfos || []).length,
        d.createable, d.updateable, d.deletable, d.feedEnabled]);
    }

    const fieldRows = [["Object","Field Label","Field API Name","Type","Length/Precision","Custom","Required","Unique","External ID","Is Formula","Formula","Default Value","References (lookup to)","Picklist Values","Help Text","Createable","Updateable"]];
    let totalFields = 0;
    for (const n of names) {
      for (const f of describes[n].fields || []) {
        totalFields++;
        let len = f.length || "";
        if (["double","currency","percent"].includes(f.type)) len = `${f.precision || 0},${f.scale || 0}`;
        const picks = (f.picklistValues || []).filter(v => v.active).map(v => v.value).join("; ");
        fieldRows.push([
          n, f.label, f.name, f.type, String(len),
          f.custom ? "Yes" : "No",
          (!f.nillable && f.createable) ? "Yes" : "No",
          f.unique ? "Yes" : "No",
          f.externalId ? "Yes" : "No",
          f.calculated ? "Yes" : "No",
          (f.calculatedFormula || "").slice(0, 2000),
          f.defaultValue == null ? "" : String(f.defaultValue),
          (f.referenceTo || []).join("; "),
          picks.length > 2000 ? picks.slice(0, 2000) + " ..." : picks,
          (f.inlineHelpText || "").slice(0, 1000),
          f.createable, f.updateable,
        ]);
      }
    }

    const wsO = XLSX.utils.aoa_to_sheet(objRows);
    const wsF = XLSX.utils.aoa_to_sheet(fieldRows);
    wsO["!autofilter"] = { ref: wsO["!ref"] };
    wsF["!autofilter"] = { ref: wsF["!ref"] };
    wsO["!cols"] = objRows[0].map((_, i) => ({ wch: Math.min(50, Math.max(...objRows.map(r => String(r[i] ?? "").length)) + 2) }));
    wsF["!cols"] = fieldRows[0].map((_, i) => ({ wch: Math.min(50, Math.max(12, ...fieldRows.slice(0, 500).map(r => String(r[i] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, wsO, "Objects");
    XLSX.utils.book_append_sheet(wb, wsF, "Fields");

    // ---- Record Types sheet ----
    const rtRows = [["Object","Record Type Label","Developer Name","Record Type Id","Active/Available","Default"]];
    for (const n of names) {
      for (const rt of describes[n].recordTypeInfos || []) {
        if (rt.master) continue;
        rtRows.push([n, rt.name, rt.developerName, rt.recordTypeId,
          rt.available ? "Yes" : "No", rt.defaultRecordTypeMapping ? "Yes" : "No"]);
      }
    }
    const wsR = XLSX.utils.aoa_to_sheet(rtRows);
    wsR["!autofilter"] = { ref: wsR["!ref"] };
    wsR["!cols"] = rtRows[0].map((_, i) => ({ wch: Math.min(45, Math.max(14, ...rtRows.map(r => String(r[i] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, wsR, "Record Types");

    // ---- Relationships sheet ----
    const relRows = [["Parent Object","Child Object","Field on Child","Relationship Name","Cascade Delete","Restricted Delete"]];
    for (const n of names) {
      for (const c of describes[n].childRelationships || []) {
        if (!c.relationshipName) continue;
        relRows.push([n, c.childSObject, c.field, c.relationshipName,
          c.cascadeDelete ? "Yes" : "No", c.restrictedDelete ? "Yes" : "No"]);
      }
    }
    const wsRel = XLSX.utils.aoa_to_sheet(relRows);
    wsRel["!autofilter"] = { ref: wsRel["!ref"] };
    wsRel["!cols"] = relRows[0].map((_, i) => ({ wch: Math.min(45, Math.max(14, ...relRows.slice(0, 500).map(r => String(r[i] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, wsRel, "Relationships");

    // ---- Picklists sheet ----
    if (withPicklists) {
      const pkRows = [["Object","Field","Field Label","Value (API)","Value Label","Active","Default"]];
      for (const n of names) {
        for (const f of describes[n].fields || []) {
          for (const v of f.picklistValues || []) {
            pkRows.push([n, f.name, f.label, v.value, v.label || v.value,
              v.active ? "Yes" : "No", v.defaultValue ? "Yes" : ""]);
          }
        }
      }
      if (pkRows.length > 1) sheetFromRows(wb, pkRows, "Picklists", 45);
    }

  return { names, totalFields };
}

// shared: code inventory rows (Apex, VF, Aura, LWC)
async function collectCodeRows() {
  const rows = [["Type","Name","API Version","Status / Detail","Namespace","Length (chars)","Last Modified","Modified By"]];
  const push = (type, r, name, detail, len) => rows.push([
    type, name, r.ApiVersion ?? "", detail ?? "", r.NamespacePrefix || "",
    len ?? "", (r.LastModifiedDate || "").slice(0, 10), r.LastModifiedBy?.Name || "",
  ]);
  const AUD = "NamespacePrefix, LastModifiedDate, LastModifiedBy.Name";
  const specs = [
    ["Apex Class", () => stdQuery(`SELECT Name, ApiVersion, Status, LengthWithoutComments, ${AUD} FROM ApexClass ORDER BY Name`),
      (r) => push("Apex Class", r, r.Name, r.Status, r.LengthWithoutComments)],
    ["Apex Trigger", () => stdQuery(`SELECT Name, ApiVersion, Status, ${AUD} FROM ApexTrigger ORDER BY Name`),
      (r) => push("Apex Trigger", r, r.Name, r.Status)],
    ["Visualforce Page", () => stdQuery(`SELECT Name, ApiVersion, ${AUD} FROM ApexPage ORDER BY Name`),
      (r) => push("Visualforce Page", r, r.Name)],
    ["Aura Bundle", () => toolingQuery(`SELECT DeveloperName, ApiVersion, ${AUD} FROM AuraDefinitionBundle ORDER BY DeveloperName`),
      (r) => push("Aura Bundle", r, r.DeveloperName)],
    ["LWC Bundle", () => toolingQuery(`SELECT DeveloperName, ApiVersion, ${AUD} FROM LightningComponentBundle ORDER BY DeveloperName`),
      (r) => push("LWC Bundle", r, r.DeveloperName)],
    // OmniStudio (standard runtime) — orgs without it just skip these
    ["OmniScript / Integration Procedure", () => stdQuery(`SELECT Name, Type, SubType, VersionNumber, IsActive, IsIntegrationProcedure, LastModifiedDate, LastModifiedBy.Name FROM OmniProcess ORDER BY Name`),
      (r) => push(r.IsIntegrationProcedure ? "Integration Procedure" : "OmniScript", r, `${r.Name} (${r.Type || ""}/${r.SubType || ""} v${r.VersionNumber ?? ""})`, r.IsActive ? "Active" : "Inactive"), true],
    ["FlexCard", () => stdQuery(`SELECT Name, VersionNumber, IsActive, LastModifiedDate, LastModifiedBy.Name FROM OmniUiCard ORDER BY Name`),
      (r) => push("FlexCard", r, `${r.Name} (v${r.VersionNumber ?? ""})`, r.IsActive ? "Active" : "Inactive"), true],
    ["DataRaptor", () => stdQuery(`SELECT Name, Type, LastModifiedDate, LastModifiedBy.Name FROM OmniDataTransform ORDER BY Name`),
      (r) => push("DataRaptor", r, r.Name, r.Type), true],
  ];
  for (const [type, fn, emit, optional] of specs) {
    try {
      setStatus(`Fetching code inventory… (${type})`, "busy");
      for (const r of await fn()) emit(r);
    } catch (e) {
      if (!optional) rows.push([type, "(query failed)", "", String(e.message), "", "", "", ""]);
      else console.warn(`${type} skipped (OmniStudio likely not enabled):`, e);
    }
  }
  return rows;
}

// shared: fetch validation rules (with formulas) for a set of object names; null on failure
async function fetchVRRows(nameSet) {
  setStatus("Fetching validation rules…", "busy");
  try {
    const rules = (await toolingQuery(
      "SELECT Id, ValidationName, Active, Description, ErrorMessage, ErrorDisplayField, " +
      "EntityDefinition.QualifiedApiName, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name " +
      "FROM ValidationRule ORDER BY EntityDefinition.QualifiedApiName, ValidationName"
    )).filter(r => nameSet.has(r.EntityDefinition?.QualifiedApiName));

    let vdone = 0;
    const vqueue = [...rules];
    async function vworker() {
      while (vqueue.length) {
        const r = vqueue.shift();
        try {
          const d = await api(`/tooling/sobjects/ValidationRule/${r.Id}`);
          r._formula = d.Metadata?.errorConditionFormula || "";
        } catch { r._formula = "(could not fetch)"; }
        vdone++;
        setStatus(`Fetching validation rules… ${vdone}/${rules.length}`, "busy");
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, vworker));

    const vrRows = [["Object","Rule Name","Active","Error Condition Formula","Error Message","Error Location","Description","Last Modified","Modified By"]];
    for (const r of rules) {
      vrRows.push([
        r.EntityDefinition?.QualifiedApiName || "", r.ValidationName,
        r.Active ? "Yes" : "No", (r._formula || "").slice(0, 4000),
        (r.ErrorMessage || "").slice(0, 1000), r.ErrorDisplayField || "(top of page)",
        (r.Description || "").slice(0, 1000),
        (r.LastModifiedDate || "").slice(0, 10), r.LastModifiedBy?.Name || "",
      ]);
    }
    return vrRows;
  } catch (e) {
    console.warn("validation rules skipped:", e);
    setStatus(`Validation rules skipped (${e.message}), continuing…`, "busy");
    return null;
  }
}

// ---------- Deployment package (changes since a date) ----------
async function collectChanges() {
  {
    const sinceRaw = $("sinceDate").value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) {
      throw new Error("Pick a date first.");
    }
    setStatus(`Finding metadata changed since ${sinceRaw}…`, "busy");
    const sinceDt = `${sinceRaw}T00:00:00Z`;
    const changes = [];
    const queried = [], unavailable = [];
    let coverage = "";

    // Path 1: SourceMember — source-tracked orgs (sandboxes/scratch): ALL metadata types
    try {
      const sm = await toolingQuery(
        `SELECT MemberType, MemberName, ChangedBy, LastModifiedDate, IsNameObsolete ` +
        `FROM SourceMember WHERE LastModifiedDate >= ${sinceDt} ORDER BY MemberType, MemberName`);
      for (const r of sm) changes.push({
        type: r.MemberType, member: r.MemberName, obj: "", label: r.MemberName,
        created: "", createdBy: "", modified: (r.LastModifiedDate || "").slice(0, 10),
        modifiedBy: r.ChangedBy || "", flag: r.IsNameObsolete ? "Deleted" : "Changed",
      });
      coverage = "all metadata types (source tracking)";
    } catch (e) { console.warn("SourceMember unavailable (normal for production), falling back:", e); }

    // Path 2: fallback — common deployable types via Tooling/standard queries
    if (!coverage) {
      coverage = "common types (no source tracking in this org)";
      // Tooling's CustomObject only gives DeveloperName, so resolve the real suffix
      // (__c, __mdt, __e, __b) from describe-global instead of assuming __c.
      const apiByDev = new Map();
      try {
        for (const s of await loadObjectList()) {
          apiByDev.set(s.name.replace(/__(c|mdt|e|b)$/i, ""), s.name);
        }
      } catch (e) { console.warn("object name map unavailable:", e); }
      const objApi = (dev) => apiByDev.get(dev) || `${dev}__c`;
      const AUD = `CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name`;
      const W = `WHERE LastModifiedDate >= ${sinceDt}`;
      const specs = [
        { type: "CustomObject", q: `SELECT DeveloperName, ${AUD} FROM CustomObject ${W}`,
          member: r => objApi(r.DeveloperName), obj: r => objApi(r.DeveloperName), label: r => r.DeveloperName },
        { type: "CustomField", q: `SELECT DeveloperName, TableEnumOrId, EntityDefinition.QualifiedApiName, ${AUD} FROM CustomField ${W}`,
          member: r => `${r.EntityDefinition?.QualifiedApiName || r.TableEnumOrId}.${r.DeveloperName}__c`,
          obj: r => r.EntityDefinition?.QualifiedApiName || "", label: r => r.DeveloperName },
        { type: "ValidationRule", q: `SELECT ValidationName, EntityDefinition.QualifiedApiName, ${AUD} FROM ValidationRule ${W}`,
          member: r => `${r.EntityDefinition?.QualifiedApiName}.${r.ValidationName}`,
          obj: r => r.EntityDefinition?.QualifiedApiName || "", label: r => r.ValidationName },
        { type: "ApexClass", q: `SELECT Name, ${AUD} FROM ApexClass ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "ApexTrigger", q: `SELECT Name, ${AUD} FROM ApexTrigger ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "ApexPage", q: `SELECT Name, ${AUD} FROM ApexPage ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "ApexComponent", q: `SELECT Name, ${AUD} FROM ApexComponent ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "Flow", q: `SELECT DeveloperName, ${AUD} FROM FlowDefinition ${W}`, member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
        { type: "FlexiPage", q: `SELECT DeveloperName, ${AUD} FROM FlexiPage ${W}`, member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
        { type: "StaticResource", q: `SELECT Name, ${AUD} FROM StaticResource ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "AuraDefinitionBundle", q: `SELECT DeveloperName, ${AUD} FROM AuraDefinitionBundle ${W}`, member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
        { type: "LightningComponentBundle", q: `SELECT DeveloperName, ${AUD} FROM LightningComponentBundle ${W}`, member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
        { type: "CustomLabel", q: `SELECT Name, ${AUD} FROM ExternalString ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "PermissionSet", std: true, q: `SELECT Name, Label, ${AUD} FROM PermissionSet WHERE IsOwnedByProfile = false AND LastModifiedDate >= ${sinceDt}`,
          member: r => r.Name, obj: () => "", label: r => r.Label || r.Name },
        { type: "PermissionSetGroup", std: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM PermissionSetGroup ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "Profile", std: true, q: `SELECT Name, ${AUD} FROM Profile ${W}`,
          member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "CustomPermission", std: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM CustomPermission ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "Queue", std: true, q: `SELECT DeveloperName, Name, ${AUD} FROM Group WHERE Type = 'Queue' AND LastModifiedDate >= ${sinceDt}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.Name || r.DeveloperName },
        { type: "RecordType", std: true, q: `SELECT SobjectType, DeveloperName, Name, ${AUD} FROM RecordType ${W}`,
          member: r => `${r.SobjectType}.${r.DeveloperName}`, obj: r => r.SobjectType, label: r => r.Name || r.DeveloperName },
        { type: "Layout", q: `SELECT Name, TableEnumOrId, ${AUD} FROM Layout ${W}`,
          member: r => `${r.TableEnumOrId}-${r.Name}`, obj: r => r.TableEnumOrId || "", label: r => r.Name },
        { type: "WorkflowRule", q: `SELECT Name, TableEnumOrId, ${AUD} FROM WorkflowRule ${W}`,
          member: r => `${r.TableEnumOrId}.${r.Name}`, obj: r => r.TableEnumOrId || "", label: r => r.Name },
        { type: "CustomTab", q: `SELECT Name, ${AUD} FROM CustomTab ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "CustomApplication", q: `SELECT DeveloperName, ${AUD} FROM CustomApplication ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
        { type: "QuickAction", q: `SELECT DeveloperName, SobjectType, ${AUD} FROM QuickActionDefinition ${W}`,
          member: r => r.SobjectType && r.SobjectType !== "Global" ? `${r.SobjectType}.${r.DeveloperName}` : r.DeveloperName,
          obj: r => r.SobjectType || "", label: r => r.DeveloperName },
        { type: "EmailTemplate", std: true, q: `SELECT DeveloperName, Name, Folder.DeveloperName, ${AUD} FROM EmailTemplate ${W}`,
          member: r => `${r.Folder?.DeveloperName || "unfiled$public"}/${r.DeveloperName}`, obj: () => "", label: r => r.Name },
        { type: "Report", std: true, q: `SELECT DeveloperName, Name, FolderName, ${AUD} FROM Report ${W}`,
          member: r => `${r.FolderName || "unfiled$public"}/${r.DeveloperName}`, obj: () => "", label: r => r.Name },
        { type: "Dashboard", std: true, q: `SELECT DeveloperName, Title, FolderName, ${AUD} FROM Dashboard ${W}`,
          member: r => `${r.FolderName || "unfiled$public"}/${r.DeveloperName}`, obj: () => "", label: r => r.Title },
        { type: "HomePageComponent", q: `SELECT Name, ${AUD} FROM HomePageComponent ${W}`, member: r => r.Name, obj: () => "", label: r => r.Name },
        // --- additional types, each optional: silently skipped when the org does not
        // --- expose them (feature off, older API, or not queryable for this user)
        { type: "WebLink", opt: true, q: `SELECT Name, PageOrSobjectType, ${AUD} FROM WebLink ${W}`,
          member: r => `${r.PageOrSobjectType}.${r.Name}`, obj: r => r.PageOrSobjectType || "", label: r => r.Name },
        { type: "ListView", std: true, opt: true, q: `SELECT DeveloperName, SobjectType, Name, ${AUD} FROM ListView ${W}`,
          member: r => `${r.SobjectType}.${r.DeveloperName}`, obj: r => r.SobjectType || "", label: r => r.Name || r.DeveloperName },
        { type: "WorkflowAlert", opt: true, q: `SELECT DeveloperName, TableEnumOrId, ${AUD} FROM WorkflowAlert ${W}`,
          member: r => `${r.TableEnumOrId}.${r.DeveloperName}`, obj: r => r.TableEnumOrId || "", label: r => r.DeveloperName },
        { type: "WorkflowFieldUpdate", opt: true, q: `SELECT DeveloperName, TableEnumOrId, ${AUD} FROM WorkflowFieldUpdate ${W}`,
          member: r => `${r.TableEnumOrId}.${r.DeveloperName}`, obj: r => r.TableEnumOrId || "", label: r => r.DeveloperName },
        { type: "WorkflowTask", opt: true, q: `SELECT DeveloperName, TableEnumOrId, ${AUD} FROM WorkflowTask ${W}`,
          member: r => `${r.TableEnumOrId}.${r.DeveloperName}`, obj: r => r.TableEnumOrId || "", label: r => r.DeveloperName },
        { type: "WorkflowOutboundMessage", opt: true, q: `SELECT DeveloperName, TableEnumOrId, ${AUD} FROM WorkflowOutboundMessage ${W}`,
          member: r => `${r.TableEnumOrId}.${r.DeveloperName}`, obj: r => r.TableEnumOrId || "", label: r => r.DeveloperName },
        { type: "BusinessProcess", opt: true, q: `SELECT Name, TableEnumOrId, ${AUD} FROM BusinessProcess ${W}`,
          member: r => `${r.TableEnumOrId}.${r.Name}`, obj: r => r.TableEnumOrId || "", label: r => r.Name },
        { type: "GlobalValueSet", opt: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM GlobalValueSet ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "ApexTestSuite", opt: true, q: `SELECT TestSuiteName, ${AUD} FROM ApexTestSuite ${W}`,
          member: r => r.TestSuiteName, obj: () => "", label: r => r.TestSuiteName },
        { type: "DuplicateRule", std: true, opt: true, q: `SELECT DeveloperName, SobjectType, MasterLabel, ${AUD} FROM DuplicateRule ${W}`,
          member: r => `${r.SobjectType}.${r.DeveloperName}`, obj: r => r.SobjectType || "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "MatchingRule", opt: true, q: `SELECT DeveloperName, SobjectType, MasterLabel, ${AUD} FROM MatchingRule ${W}`,
          member: r => `${r.SobjectType}.${r.DeveloperName}`, obj: r => r.SobjectType || "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "PathAssistant", opt: true, q: `SELECT DeveloperName, SobjectType, MasterLabel, ${AUD} FROM PathAssistant ${W}`,
          member: r => r.DeveloperName, obj: r => r.SobjectType || "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "CustomNotificationType", std: true, opt: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM CustomNotificationType ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "NamedCredential", std: true, opt: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM NamedCredential ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "ExternalDataSource", std: true, opt: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM ExternalDataSource ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "RemoteSiteSetting", opt: true, q: `SELECT SiteName, ${AUD} FROM RemoteProxy ${W}`,
          member: r => r.SiteName, obj: () => "", label: r => r.SiteName },
        { type: "CorsWhitelistOrigin", opt: true, q: `SELECT UrlPattern, ${AUD} FROM CorsWhitelistEntry ${W}`,
          member: r => r.UrlPattern, obj: () => "", label: r => r.UrlPattern },
        { type: "AuthProvider", std: true, opt: true, q: `SELECT DeveloperName, FriendlyName, ${AUD} FROM AuthProvider ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.FriendlyName || r.DeveloperName },
        { type: "CspTrustedSite", opt: true, q: `SELECT DeveloperName, EndpointUrl, ${AUD} FROM CspTrustedSite ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.EndpointUrl || r.DeveloperName },
        { type: "EmailServicesFunction", std: true, opt: true, q: `SELECT FunctionName, ${AUD} FROM EmailServicesFunction ${W}`,
          member: r => r.FunctionName, obj: () => "", label: r => r.FunctionName },
        { type: "CustomSite", std: true, opt: true, q: `SELECT Name, MasterLabel, ${AUD} FROM Site ${W}`,
          member: r => r.Name, obj: () => "", label: r => r.MasterLabel || r.Name },
        { type: "Network", std: true, opt: true, q: `SELECT Name, ${AUD} FROM Network ${W}`,
          member: r => r.Name, obj: () => "", label: r => r.Name },
        { type: "Territory2Model", std: true, opt: true, q: `SELECT DeveloperName, Name, ${AUD} FROM Territory2Model ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.Name || r.DeveloperName },
        { type: "Territory2", std: true, opt: true, q: `SELECT DeveloperName, Territory2Model.DeveloperName, Name, ${AUD} FROM Territory2 ${W}`,
          member: r => `${r.Territory2Model?.DeveloperName}.${r.DeveloperName}`, obj: () => "", label: r => r.Name || r.DeveloperName },
        { type: "Territory2Rule", std: true, opt: true, q: `SELECT DeveloperName, Territory2Model.DeveloperName, Name, ${AUD} FROM Territory2Rule ${W}`,
          member: r => `${r.Territory2Model?.DeveloperName}.${r.DeveloperName}`, obj: () => "", label: r => r.Name || r.DeveloperName },
        { type: "PlatformEventChannel", opt: true, q: `SELECT DeveloperName, MasterLabel, ${AUD} FROM PlatformEventChannel ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.MasterLabel || r.DeveloperName },
        { type: "CustomObjectTranslation", opt: true, q: `SELECT DeveloperName, ${AUD} FROM CustomObjectTranslation ${W}`,
          member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
        { type: "CustomMetadataType", q: `SELECT DeveloperName, ${AUD} FROM CustomObject WHERE DeveloperName != null AND LastModifiedDate >= ${sinceDt}`,
          skip: true, member: r => r.DeveloperName, obj: () => "", label: r => r.DeveloperName },
      ].filter(s => !s.skip);
      for (const s of specs) {
        try {
          const recs = await (s.std ? stdQuery(s.q) : toolingQuery(s.q));
          for (const r of recs) changes.push({
            type: s.type, member: s.member(r), obj: s.obj(r), label: s.label(r),
            created: (r.CreatedDate || "").slice(0, 10), createdBy: r.CreatedBy?.Name || "",
            modified: (r.LastModifiedDate || "").slice(0, 10), modifiedBy: r.LastModifiedBy?.Name || "",
            flag: r.CreatedDate >= sinceDt ? "New" : "Modified",
          });
          queried.push(s.type);
        } catch (e) {
          if (!s.opt) unavailable.push(`${s.type} (${String(e.message).slice(0, 80)})`);
          console.warn(`${s.type} skipped:`, e);
        }
        setStatus(`Finding metadata changed since ${sinceRaw}… (${s.type})`, "busy");
      }
    }

    return { sinceRaw, changes, coverage, queried, unavailable };
  }
}

async function exportPackage() {
  const btn = $("packageBtn");
  btn.disabled = true;
  try {
    const { sinceRaw, changes, coverage, queried, unavailable } = await collectChanges();
    const chRows = [["Component Type","Metadata API Name (package.xml)","Object","Label","Created Date","Created By","Last Modified","Modified By","Status"]];
    for (const c of changes) chRows.push([c.type, c.member, c.obj, c.label, c.created, c.createdBy, c.modified, c.modifiedBy, c.flag]);
    chRows.push([]);
    chRows.push([`Coverage: ${coverage}`]);
    if (queried.length) chRows.push([`Types queried: ${queried.join(", ")}`]);
    if (unavailable.length) chRows.push([`Types not available in this org: ${unavailable.join(" | ")}`]);
    chRows.push(["Not reachable from the browser, use the Metadata API (sf project retrieve) for these:"]);
    chRows.push(["sharing rules · assignment rules · escalation rules · auto-response rules · connected apps · certificates · SAML/SSO config · layout assignments · record-type picklist mappings · field sets · compact layouts · most feature-gated types (CPQ, Field Service, Industries)"]);
    chRows.push(["Custom metadata and custom settings: the TYPE definitions (Foo__mdt) are covered above as CustomObject, along with their fields. The RECORDS inside them are data, so deploy them as CustomMetadata members or with a data load, a last-modified query cannot see them."]);
    chRows.push(["Tip: run this against a source-tracked sandbox instead, Org Lens then uses SourceMember and covers every metadata type."]);
    const wbC = XLSX.utils.book_new();
    const wsC = XLSX.utils.aoa_to_sheet(chRows);
    wsC["!autofilter"] = { ref: `A1:I${changes.length + 1}` };
    wsC["!cols"] = chRows[0].map((_, i) => ({ wch: Math.min(55, Math.max(14, ...chRows.map(r => String(r[i] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wbC, wsC, "Changes Since");

    // package.xml (deleted members excluded)
    const byType = {};
    for (const c of changes) {
      if (c.flag === "Deleted" || !c.member) continue;
      (byType[c.type] ||= new Set()).add(c.member);
    }
    if (Object.keys(byType).length) {
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        Object.keys(byType).sort().map(t =>
          `    <types>\n` +
          [...byType[t]].sort().map(m => `        <members>${esc(m)}</members>`).join("\n") +
          `\n        <name>${esc(t)}</name>\n    </types>`
        ).join("\n") +
        `\n    <version>${API_VERSION.replace("v", "")}</version>\n</Package>\n`;
      downloadText(`package_since_${sinceRaw}.xml`, xml);
    }

    const host = new URL(auth.instanceUrl).hostname.split(".")[0];
    XLSX.writeFile(wbC, `${host}_changes_since_${sinceRaw}.xlsx`);
    setStatus(`Done, ${changes.length} changed components (${coverage}). Excel + package.xml downloaded.`, "ok");
  } catch (e) {
    setStatus(`Package build failed: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------- second org (another logged-in session) ----------
let auth2 = null;



// ---------- profile / permission set matrix across three or more sides ----------
// One side's whole picture as a flat map: "Area|Item" -> value. The five areas are the
// same reads the A vs B path uses, so the numbers match; only the shape differs.
async function profSideSnapshot(a, id) {
  const m = new Map();
  const OPKEYS = [["PermissionsRead","Read"],["PermissionsCreate","Create"],["PermissionsEdit","Edit"],
    ["PermissionsDelete","Delete"],["PermissionsViewAllRecords","View All"],["PermissionsModifyAllRecords","Modify All"]];

  const ops = await stdQueryFor(a, "SELECT SobjectType, " + OPKEYS.map(k => k[0]).join(", ") +
    " FROM ObjectPermissions WHERE ParentId = '" + id + "'");
  for (const r of ops) for (const [k, label] of OPKEYS) m.set(`Object CRUD|${r.SobjectType} · ${label}`, r[k] ? "Yes" : "No");

  const fps = await stdQueryFor(a, "SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '" + id + "'");
  for (const r of fps) m.set(`Field security|${r.Field}`, r.PermissionsEdit ? "Edit" : r.PermissionsRead ? "Read" : "None");

  try {
    const res = await apiFor(a, "/query/?q=" + encodeURIComponent(
      "SELECT FIELDS(STANDARD) FROM PermissionSet WHERE Id = '" + id + "' LIMIT 1"));
    const rec = (res.records || [])[0] || {};
    for (const k of Object.keys(rec)) {
      if (k.indexOf("Permissions") !== 0) continue;
      m.set(`System permission|${k.replace(/^Permissions/, "")}`, rec[k] ? "Yes" : "No");
    }
  } catch (err) { console.warn("system permissions unavailable:", err); }

  try {
    const sea = await stdQueryFor(a, "SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = '" + id +
      "' AND SetupEntityType IN ('ApexClass','ApexPage','CustomPermission','ConnectedApplication','TabSet')");
    const names = new Map();
    const resolvers = [
      ["ApexClass", (i) => "SELECT Id, Name FROM ApexClass WHERE Id IN (" + i + ")"],
      ["ApexPage", (i) => "SELECT Id, Name FROM ApexPage WHERE Id IN (" + i + ")"],
      ["CustomPermission", (i) => "SELECT Id, DeveloperName FROM CustomPermission WHERE Id IN (" + i + ")"],
    ];
    for (const [type, q] of resolvers) {
      const ids = sea.filter(r => r.SetupEntityType === type).map(r => "'" + r.SetupEntityId + "'");
      for (let i = 0; i < ids.length; i += 200) {
        try {
          for (const r of await stdQueryFor(a, q(ids.slice(i, i + 200).join(",")))) names.set(r.Id, r.Name || r.DeveloperName);
        } catch (err) { console.warn(type + " resolve failed:", err); }
      }
    }
    for (const r of sea) m.set(`Apex / VF / custom|${r.SetupEntityType} · ${names.get(r.SetupEntityId) || r.SetupEntityId}`, "Yes");
  } catch (err) { console.warn("setup entity access unavailable:", err); }

  try {
    const tabs = await stdQueryFor(a, "SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = '" + id + "'");
    for (const r of tabs) m.set(`Tab visibility|${r.Name}`, r.Visibility);
  } catch (err) { console.warn("tab visibility unavailable:", err); }

  return m;
}

let pmxRows = [], pmxCols = [];

// Absent means the permission is simply not granted on that side, which is why a missing
// key reads as the area's own "off" value rather than an empty cell.
function profBlank(area) {
  if (area === "Field security") return "None";
  if (area === "Tab visibility") return "Hidden";
  return "No";
}

async function collectProfMatrix() {
  const kind = $("cmpKind").value;
  const kindLabel = kind === "profile" ? "Profile" : "Permission set";
  const sides = [];
  for (const s of profSlots) {
    const host = $("profOrg" + s).value;
    const id = $("prof" + s).value;
    if (!id) throw new Error(`Side ${s} has no ${kindLabel.toLowerCase()} selected.`);
    const pid = $("prof" + s).selectedOptions[0]?.dataset?.pid;
    sides.push({ slot: s, host, id, pid, name: $("prof" + s).selectedOptions[0]?.textContent || s });
  }
  const seen = new Set();
  for (const s of sides) {
    const key = s.host + "|" + s.id;
    if (seen.has(key)) throw new Error(`Sides ${sides.filter(x => x.host + "|" + x.id === key).map(x => x.slot).join(" and ")} are the same ${kindLabel.toLowerCase()} in the same org.`);
    seen.add(key);
  }

  const total = sides.length;
  for (let i = 0; i < total; i++) {
    setProgress((i / total) * 100, `Reading side ${sides[i].slot} (${sides[i].name})`);
    setStatus(`Reading side ${sides[i].slot}…`, "busy");
    const a = await sessionForHost(sides[i].host);
    sides[i].map = await profSideSnapshot(a, sides[i].id);
    sides[i].label = `${sides[i].name} @ ${sides[i].host.split(".")[0]}`;
  }
  setProgress(null);

  const keys = new Set();
  for (const s of sides) for (const k of s.map.keys()) keys.add(k);
  const diffOnly = $("profDiffOnly").checked;
  const rows = [];
  for (const k of [...keys].sort()) {
    const area = k.split("|")[0], item = k.slice(area.length + 1);
    const values = sides.map(s => s.map.get(k) ?? profBlank(area));
    const same = values.every(v => v === values[0]);
    if (diffOnly && same) continue;
    rows.push({ area, item, values, status: same ? "Same everywhere" : "Differs" });
  }
  pmxRows = rows;
  pmxCols = sides.map(s => ({ slot: s.slot, label: s.label,
    url: kind === "profile"
      ? (s.pid ? setupUrl.profile(s.pid, s.host) : "")
      : setupUrl.permSet(s.id, s.host) }));
  return { kindLabel, sides, rows, diffOnly };
}

function renderProfMatrix(res) {
  $("profResult").style.display = "none";
  $("pmxHead").innerHTML = `<tr><th>Area</th><th>Item</th>` +
    pmxCols.map(c => `<th>${escHtml(c.slot)} · ` +
      (c.url ? `<a href="${escHtml(c.url)}" target="_blank" rel="noopener" title="Open in Setup">${escHtml(c.label)}</a>`
             : escHtml(c.label)) + `</th>`).join("") + `<th>Status</th></tr>`;
  const shown = pmxRows.slice(0, 600);
  $("pmxBody").innerHTML = shown.map(r =>
    `<tr><td>${escHtml(r.area)}</td><td>${escHtml(r.item)}</td>` +
    r.values.map(v => `<td class="${/^(No|None|Hidden)$/.test(v) ? "accNone" : ""}">${escHtml(v)}</td>`).join("") +
    `<td class="${r.status === "Differs" ? "accRead" : ""}">${escHtml(r.status)}</td></tr>`).join("")
    || `<tr><td colspan="${pmxCols.length + 3}" style="color:var(--faint);">Nothing to show.</td></tr>`;
  $("pmxResTitle").textContent = `${res.kindLabel} across ${pmxCols.length} sides`;
  $("pmxResNote").textContent = (res.diffOnly ? "Differences only. " : "Every permission on every side. ") +
    `${pmxRows.length} rows.` + (pmxRows.length > 600 ? ` Showing the first 600.` : "");
  const differs = pmxRows.filter(r => r.status === "Differs").length;
  $("pmxResSummary").innerHTML = pmxCols.map(c => `<span class="fact">${escHtml(c.slot)}: <b>${escHtml(c.label)}</b></span>`).join("") +
    `<span class="fact">Rows that differ: <b>${differs}</b></span>`;
  flashBox("pmxResult");
}

async function profMatrixShow() {
  const btn = $("profShowBtn");
  btn.disabled = true;
  try { renderProfMatrix(await collectProfMatrix()); setStatus(""); }
  catch (err) { setProgress(null); setStatus(`Matrix failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function profMatrixExport() {
  const btn = $("profCmpBtn");
  btn.disabled = true;
  try {
    const res = await collectProfMatrix();
    renderProfMatrix(res);
    const header = ["Area", "Item", ...pmxCols.map(c => `${c.slot} · ${c.label}`), "Status"];
    const rows = [header, ...pmxRows.map(r => [r.area, r.item, ...r.values, r.status])];
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, rows, "Permission matrix");
    XLSX.writeFile(wb, `permission-matrix-${pmxCols.length}-sides-${today()}.xlsx`);
    setStatus(`Done, ${pmxRows.length} rows across ${pmxCols.length} sides.`, "ok");
  } catch (err) { setProgress(null); setStatus(`Export failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

// ---------- all limits, not just the six tiles ----------
let allLimits = null;

// The endpoint returns one entry per limit, sometimes with nested per-namespace children.
// Anything without a Max is not a real ceiling, so it is skipped rather than shown as 0.
function limitRows() {
  const rows = [];
  for (const [key, o] of Object.entries(allLimits || {})) {
    if (!o || typeof o.Max !== "number" || !o.Max) continue;
    const used = o.Max - (o.Remaining ?? 0);
    rows.push({ name: key.replace(/([a-z])([A-Z])/g, "$1 $2"), key, used, max: o.Max,
                remaining: o.Remaining ?? 0, pct: Math.min(100, Math.round(used / o.Max * 100)) });
  }
  return rows.sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
}

function renderLimits() {
  const rows = limitRows();
  const term = $("limitsFilter").value.trim().toLowerCase();
  const shown = term ? rows.filter(r => r.name.toLowerCase().includes(term) || r.key.toLowerCase().includes(term)) : rows;
  $("limitsTitle").textContent = `${rows.length} limits reported`;
  $("limitsList").innerHTML = shown.map(r =>
    `<tr><td>${escHtml(r.name)}</td><td>${fmt(r.used)}</td><td>${fmt(r.max)}</td><td>${fmt(r.remaining)}</td>` +
    `<td class="${r.pct >= 90 ? "accNone" : r.pct >= 70 ? "accRead" : ""}">${r.pct}%</td></tr>`).join("")
    || `<tr><td colspan="5" style="color:var(--faint);">Nothing matches that filter.</td></tr>`;
}

function toggleLimits() {
  const box = $("limitsBox");
  const open = box.style.display !== "block";
  if (open && !allLimits) return setStatus("Limits are still loading, or this user cannot read them.", "err");
  box.style.display = open ? "block" : "none";
  $("limitsToggleLabel").textContent = open ? "Hide all limits" : "Show all limits";
  if (open) { renderLimits(); flashBox("limitsBox"); }
}

// Setup deep links for the containers a permission can come from. Each keeps you inside
// Lightning: a bare record id resolves but hands you the Classic page.

// Every URL is built from a session, never assembled by hand at the call site. A host on its
// own resolves through the session cache first, so if a session ever carries something other
// than https or a plain hostname, one function has to change rather than six call sites.
function baseUrl(target) {
  if (!target) return auth ? auth.instanceUrl : "";
  if (typeof target === "object") return target.instanceUrl || "";        // a session
  if (/^https?:\/\//i.test(target)) return new URL(target).origin;       // already a URL
  const known = sessionByHost.get(target);                               // a host we hold a session for
  if (known?.instanceUrl) return known.instanceUrl;
  if (auth && apiHostOf(auth) === target) return auth.instanceUrl;
  if (auth2 && apiHostOf(auth2) === target) return auth2.instanceUrl;
  return new URL(`https://${target}`).origin;                            // last resort
}

// Salesforce's own Setup routes, named once
const SETUP_PATH = {
  home: "/lightning/setup/SetupOneHome/home",
  profile: "/lightning/setup/EnhancedProfiles/page?address=",
  permSet: "/lightning/setup/PermSets/page?address=",
  permSetGroup: "/lightning/setup/PermSetGroups/page?address=",
  profileList: "/lightning/setup/EnhancedProfiles/home",
  permSetList: "/lightning/setup/PermSets/home",
  objectManager: "/lightning/setup/ObjectManager/",
};

const setupUrl = {
  // the second argument is a session or a host, because a comparison can straddle two orgs
  profile: (id, org) => baseUrl(org) + SETUP_PATH.profile + encodeURIComponent(`/${id}`),
  permSet: (id, org) => baseUrl(org) + SETUP_PATH.permSet + encodeURIComponent(`/${id}`),
  permSetGroup: (id, org) => baseUrl(org) + SETUP_PATH.permSetGroup + encodeURIComponent(`/${id}`),
  home: (org) => baseUrl(org) + SETUP_PATH.home,
};

// ---------- security posture ----------
// The four permissions that let someone step around everything else. Each is held either
// on the user's profile or on an assigned permission set, so both paths are reported.
const SEC_PERMS = [
  ["PermissionsModifyAllData", "Modify All Data"],
  ["PermissionsViewAllData", "View All Data"],
  ["PermissionsAuthorApex", "Author Apex"],
  ["PermissionsManageUsers", "Manage Users"],
];

let secElev = [], secUnused = [], secFacts = null;

async function collectSecurity() {
  const activeOnly = $("secActiveOnly").checked;
  setProgress(5, "Reading permission sets and profiles");
  setStatus("Reading permission containers…", "busy");

  // every container that grants one of the four, profile-owned or standalone
  const permCols = SEC_PERMS.map(p => p[0]).join(", ");
  const where = SEC_PERMS.map(p => p[0] + " = true").join(" OR ");
  const containers = await stdQuery(
    `SELECT Id, Name, Label, IsOwnedByProfile, ProfileId, Profile.Name, ${permCols} ` +
    `FROM PermissionSet WHERE ${where}`);

  setProgress(30, "Reading assignments");
  const ids = containers.map(c => `'${c.Id}'`);
  const assigns = [];
  // Assigning a permission set GROUP writes an assignment against the group's calculated
  // aggregate set, so asking for PermissionSetGroup.MasterLabel is what turns an opaque
  // aggregate into the group name a person can actually go and edit. Older orgs reject the
  // field, so the query falls back to the plain shape.
  let haveGroups = true;
  for (let i = 0; i < ids.length; i += 200) {
    const inList = ids.slice(i, i + 200).join(",");
    const base = `Assignee.Name, Assignee.Username, Assignee.IsActive, Assignee.Profile.Name`;
    try {
      if (!haveGroups) throw new Error("skip");
      assigns.push(...await stdQuery(
        `SELECT PermissionSetId, PermissionSetGroupId, PermissionSetGroup.MasterLabel, ${base} ` +
        `FROM PermissionSetAssignment WHERE PermissionSetId IN (${inList})`));
    } catch (err) {
      haveGroups = false;
      assigns.push(...await stdQuery(
        `SELECT PermissionSetId, ${base} FROM PermissionSetAssignment WHERE PermissionSetId IN (${inList})`));
    }
  }

  const byId = new Map(containers.map(c => [c.Id, c]));
  const rows = [];
  for (const a of assigns) {
    const c = byId.get(a.PermissionSetId);
    if (!c) continue;
    const u = a.Assignee || {};
    if (activeOnly && u.IsActive === false) continue;
    // a profile-owned permission set IS the profile, so that is how it is credited
    const via = c.IsOwnedByProfile
      ? `Profile: ${c.Profile?.Name || "(unnamed)"}`
      : a.PermissionSetGroupId
        ? `Permission set group: ${a.PermissionSetGroup?.MasterLabel || c.Label || c.Name}`
        : `Permission set: ${c.Label || c.Name}`;
    // the row links to whatever actually grants it, which is where you would go to revoke it
    const viaUrl = c.IsOwnedByProfile
      ? (c.ProfileId ? setupUrl.profile(c.ProfileId) : "")
      : a.PermissionSetGroupId ? setupUrl.permSetGroup(a.PermissionSetGroupId) : setupUrl.permSet(c.Id);
    for (const [key, label] of SEC_PERMS) {
      if (!c[key]) continue;
      rows.push({ user: u.Name || "(unknown)", username: u.Username || "", profile: u.Profile?.Name || "",
                  active: u.IsActive === false ? "No" : "Yes", perm: label, via, url: viaUrl });
    }
  }
  rows.sort((a, b) => a.perm.localeCompare(b.perm) || a.user.localeCompare(b.user));

  setProgress(60, "Looking for unused permission sets");
  const allSets = await stdQuery(
    "SELECT Id, Name, Label, Type FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label");
  const assignedIds = new Set();
  for (let i = 0; i < allSets.length; i += 200) {
    const chunk = allSets.slice(i, i + 200).map(s => `'${s.Id}'`).join(",");
    for (const a of await stdQuery(
      `SELECT PermissionSetId FROM PermissionSetAssignment WHERE PermissionSetId IN (${chunk})`)) {
      assignedIds.add(a.PermissionSetId);
    }
  }

  // A set can be granted two ways: assigned to people directly, or dropped into a permission
  // set group that is assigned. Counting only the first would report every group component as
  // dead, so group membership counts as in use and names the group it sits in.
  const inGroup = new Map();
  let groupsRead = true;
  try {
    for (const c of await stdQuery(
      "SELECT PermissionSetId, PermissionSetGroup.MasterLabel FROM PermissionSetGroupComponent")) {
      const label = c.PermissionSetGroup?.MasterLabel || "(unnamed group)";
      if (!inGroup.has(c.PermissionSetId)) inGroup.set(c.PermissionSetId, new Set());
      inGroup.get(c.PermissionSetId).add(label);
    }
  } catch (err) {
    groupsRead = false;   // org without permission set groups, or no access to the component object
    console.warn("permission set group components unavailable:", err);
  }

  // Session, group-aggregate and muting sets are machinery, not containers an admin assigns.
  const MACHINERY = new Set(["Session", "Group", "Muting"]);
  const unused = allSets
    .filter(s => !assignedIds.has(s.Id) && !inGroup.has(s.Id) && !MACHINERY.has(s.Type))
    .map(s => ({ type: "Permission set", name: s.Label || s.Name, url: setupUrl.permSet(s.Id),
                 note: groupsRead ? "No assignees, and in no permission set group"
                                  : "No direct assignees (group membership could not be read)" }));

  // group members with no direct assignment are fine, but worth seeing as a separate note
  const viaGroupOnly = allSets
    .filter(s => !assignedIds.has(s.Id) && inGroup.has(s.Id))
    .map(s => ({ type: "Permission set", name: s.Label || s.Name, url: setupUrl.permSet(s.Id),
                 note: "Granted only through " + [...inGroup.get(s.Id)].sort().join(", ") }));

  // an outdated group is not recalculated yet, so what it grants today is not what it should
  let staleGroups = [];
  try {
    staleGroups = (await stdQuery("SELECT Id, MasterLabel, Status FROM PermissionSetGroup WHERE Status != 'Updated'"))
      .map(g => ({ type: "Permission set group", name: g.MasterLabel, url: setupUrl.permSetGroup(g.Id),
                   note: `Status ${g.Status}, so its permissions are not recalculated yet` }));
  } catch (err) { console.warn("permission set group status unavailable:", err); }

  setProgress(80, "Looking for profiles with no users");
  const profiles = await stdQuery("SELECT Id, Name, UserType FROM Profile ORDER BY Name");
  // Count users of EVERY type, not just Standard. A site's guest user is UserType 'Guest',
  // community and partner users are portal types, and filtering them out made every profile
  // behind a site or a community look unused: the worst possible advice in a cleanup list.
  // The aggregate also replaces a row-per-user read, which on a large org was thousands.
  const userCounts = new Map();
  const byType = new Map();
  try {
    const agg = await stdQuery("SELECT ProfileId, UserType, COUNT(Id) c FROM User" +
      (activeOnly ? " WHERE IsActive = true" : "") + " GROUP BY ProfileId, UserType");
    for (const r of agg) {
      userCounts.set(r.ProfileId, (userCounts.get(r.ProfileId) || 0) + (r.c || 0));
      if (r.c) {
        if (!byType.has(r.ProfileId)) byType.set(r.ProfileId, new Set());
        byType.get(r.ProfileId).add(r.UserType || "unknown");
      }
    }
  } catch (err) {
    // an org that refuses the aggregate falls back to counting rows, still across all types
    console.warn("user aggregate unavailable, counting rows:", err);
    for (const u of await stdQuery("SELECT ProfileId FROM User" + (activeOnly ? " WHERE IsActive = true" : ""))) {
      userCounts.set(u.ProfileId, (userCounts.get(u.ProfileId) || 0) + 1);
    }
  }
  for (const p of profiles) {
    if (userCounts.get(p.Id)) continue;
    // a portal or guest profile with no users is worth a softer note: it may be waiting on a
    // site or community rather than being dead
    const portal = p.UserType && p.UserType !== "Standard";
    unused.push({ type: "Profile", name: p.Name, url: setupUrl.profile(p.Id),
      note: (activeOnly ? "No active users" : "No users") + " of any type" +
        (portal ? `, and it is a ${p.UserType} profile, so check for a site or community first` : "") });
  }

  setProgress(95, "Counting admins");
  const admins = rows.filter(r => r.perm === "Modify All Data");
  const adminPeople = new Set(admins.map(r => r.username || r.user));
  setProgress(null);
  setStatus("");

  secElev = rows;
  secUnused = [...unused, ...staleGroups, ...viaGroupOnly];
  secFacts = {
    activeOnly,
    people: new Set(rows.map(r => r.username || r.user)).size,
    admins: adminPeople.size,
    grants: rows.length,
    unusedSets: unused.filter(u => u.type === "Permission set").length,
    emptyProfiles: unused.filter(u => u.type === "Profile").length,
    groupOnly: viaGroupOnly.length,
    staleGroups: staleGroups.length,
    groupsRead,
    byPerm: SEC_PERMS.map(([, label]) => [label, new Set(rows.filter(r => r.perm === label).map(r => r.username || r.user)).size]),
  };
  return secFacts;
}

function renderSecurity() {
  const f = secFacts;
  $("secResTitle").textContent = `${f.people} people hold elevated access`;
  $("secResNote").textContent = (f.activeOnly ? "Active users only. " : "Active, frozen and inactive users. ") +
    "A person is listed once per permission, and the row says whether it came from their profile or an assigned permission set. Click a row to open that profile, permission set or group in Setup.";
  $("secResSummary").innerHTML =
    f.byPerm.map(([label, n]) => `<span class="fact">${escHtml(label)}: <b>${n}</b></span>`).join("") +
    `<span class="fact">Unused permission sets: <b>${f.unusedSets}</b></span>` +
    `<span class="fact">Profiles with no users: <b>${f.emptyProfiles}</b></span>` +
    (f.groupOnly ? `<span class="fact">Granted only through a group: <b>${f.groupOnly}</b></span>` : "") +
    (f.staleGroups ? `<span class="fact">Groups not recalculated: <b>${f.staleGroups}</b></span>` : "");
  $("secElevTitle").textContent = `${f.grants} grants across ${f.people} people`;
  renderSecList();
  $("secUnusedTitle").textContent = f.groupsRead
    ? `${f.unusedSets + f.emptyProfiles} unused, ${f.groupOnly} group-only, ${f.staleGroups} stale`
    : `${secUnused.length} rows (group membership could not be read, so treat "unused" with care)`;
  $("secUnusedList").innerHTML = secUnused.map(u =>
    `<tr class="${u.url ? "objrow" : ""}" ${u.url ? `data-url="${escHtml(u.url)}" title="Open in Setup"` : ""}>` +
    `<td>${escHtml(u.type)}</td><td>${escHtml(u.name)}</td><td>${escHtml(u.note)}</td></tr>`).join("")
    || `<tr><td colspan="3" style="color:var(--faint);">Everything is in use.</td></tr>`;
  flashBox("secResult");
}

function renderSecList() {
  const term = $("secFilter").value.trim().toLowerCase();
  const shown = (term
    ? secElev.filter(r => `${r.user} ${r.username} ${r.profile} ${r.perm} ${r.via}`.toLowerCase().includes(term))
    : secElev).slice(0, 600);
  $("secElevList").innerHTML = shown.map(r =>
    `<tr class="${r.url ? "objrow" : ""}" ${r.url ? `data-url="${escHtml(r.url)}" title="Open what grants this in Setup"` : ""}>` +
    `<td>${escHtml(r.user)}</td><td>${escHtml(r.username)}</td><td>${escHtml(r.profile)}</td>` +
    `<td class="${r.active === "No" ? "accNone" : ""}">${escHtml(r.active)}</td>` +
    `<td class="${r.perm === "Modify All Data" ? "accNone" : "accRead"}">${escHtml(r.perm)}</td>` +
    `<td>${escHtml(r.via)}</td></tr>`).join("")
    || `<tr><td colspan="6" style="color:var(--faint);">Nothing to show.</td></tr>`;
}

async function securityShow() {
  const btn = $("secShowBtn");
  btn.disabled = true;
  try { await collectSecurity(); renderSecurity(); }
  catch (err) { setProgress(null); setStatus(`Posture failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function securityExport() {
  const btn = $("secExportBtn");
  btn.disabled = true;
  try {
    await collectSecurity();
    renderSecurity();
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["User", "Username", "Profile", "Active", "Permission", "Granted via"],
      ...secElev.map(r => [r.user, r.username, r.profile, r.active, r.perm, r.via])], "Elevated access", 45);
    sheetFromRows(wb, [["Type", "Name", "Note"], ...secUnused.map(u => [u.type, u.name, u.note])], "Unused");
    sheetFromRows(wb, [["Measure", "Value"],
      ...secFacts.byPerm.map(([label, n]) => [label + " (people)", n]),
      ["People with elevated access", secFacts.people],
      ["Grants", secFacts.grants],
      ["Unused permission sets", secFacts.unusedSets],
      ["Profiles with no users", secFacts.emptyProfiles],
      ["Scope", secFacts.activeOnly ? "Active users only" : "All users"],
      ["Run", today()]], "About");
    XLSX.writeFile(wb, `security-posture-${today()}.xlsx`);
    setStatus(`Done, ${secElev.length} grants and ${secUnused.length} unused containers.`, "ok");
  } catch (err) { setProgress(null); setStatus(`Export failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

// ---------- Setup audit trail ----------
async function collectAudit() {
  const since = $("auditSince").value;
  if (!since) throw new Error("Pick a start date.");
  const user = $("auditUser").value.trim().toLowerCase();
  const text = $("auditText").value.trim().toLowerCase();
  setStatus("Reading the audit trail…", "busy");
  const rows = await stdQuery(
    `SELECT CreatedDate, CreatedBy.Name, CreatedBy.Username, Section, Action, Display, DelegateUser ` +
    `FROM SetupAuditTrail WHERE CreatedDate >= ${since}T00:00:00Z ORDER BY CreatedDate DESC`);
  setStatus("");
  const filtered = rows.filter(r => {
    const who = `${r.CreatedBy?.Name || ""} ${r.CreatedBy?.Username || ""}`.toLowerCase();
    const what = `${r.Section || ""} ${r.Action || ""} ${r.Display || ""}`.toLowerCase();
    return (!user || who.includes(user)) && (!text || what.includes(text));
  });
  return { rows: filtered, total: rows.length, since };
}

function renderAudit(res) {
  const byUser = {}, bySection = {};
  for (const r of res.rows) {
    const u = r.CreatedBy?.Name || "(unknown)";
    byUser[u] = (byUser[u] || 0) + 1;
    const s = r.Section || "(none)";
    bySection[s] = (bySection[s] || 0) + 1;
  }
  const top = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 4);
  $("auditResTitle").textContent = `${res.rows.length} change${res.rows.length === 1 ? "" : "s"} since ${res.since}`;
  $("auditResNote").textContent = res.rows.length
    ? `${Object.keys(byUser).length} people, ${Object.keys(bySection).length} setup areas.` +
      (res.rows.length < res.total ? ` Filtered from ${res.total} entries.` : "")
    : "No entries match. Salesforce keeps roughly six months of audit history, older changes are gone.";
  $("auditResSummary").innerHTML = top.map(([u, n]) => `<span class="r">${escHtml(u)}: ${n}</span>`).join("") ||
    `<span class="n">nothing in range</span>`;
  $("auditResList").innerHTML = res.rows.slice(0, 600).map(r =>
    `<tr><td>${escHtml((r.CreatedDate || "").replace("T", " ").slice(0, 16))}</td>` +
    `<td>${escHtml(r.CreatedBy?.Name || "")}${r.DelegateUser ? ` <span class="accNone">(as ${escHtml(r.DelegateUser)})</span>` : ""}</td>` +
    `<td>${escHtml(r.Section || "")}</td><td>${escHtml(r.Display || r.Action || "")}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:var(--faint);">Nothing to show.</td></tr>`;
  if (res.rows.length > 600) $("auditResNote").textContent += ` Showing the first 600.`;
  flashBox("auditResult");
}

async function auditShow() {
  const btn = $("auditShowBtn");
  btn.disabled = true;
  try { renderAudit(await collectAudit()); }
  catch (err) { setStatus(`Audit trail failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function auditExport() {
  const btn = $("auditExportBtn");
  btn.disabled = true;
  try {
    const res = await collectAudit();
    renderAudit(res);
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["When", "User", "Username", "Section", "Action", "What changed", "Delegate"],
      ...res.rows.map(r => [(r.CreatedDate || "").replace("T", " ").slice(0, 19), r.CreatedBy?.Name || "",
        r.CreatedBy?.Username || "", r.Section || "", r.Action || "", r.Display || "", r.DelegateUser || ""])], "Audit Trail", 70);
    const byUser = {};
    for (const r of res.rows) { const u = r.CreatedBy?.Name || "(unknown)"; byUser[u] = (byUser[u] || 0) + 1; }
    sheetFromRows(wb, [["User", "Changes"], ...Object.entries(byUser).sort((a, b) => b[1] - a[1])], "By User");
    XLSX.writeFile(wb, `${hostOf(auth)}_audit_trail_${today()}.xlsx`);
    setStatus(`Exported ${res.rows.length} audit entries.`, "ok");
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- Apex tests & coverage ----------
async function collectCoverage() {
  setStatus("Reading code coverage…", "busy");
  // ApexCodeCoverageAggregate holds the org's last-run coverage per class
  const cov = await toolingQuery(
    "SELECT ApexClassOrTriggerId, ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered " +
    "FROM ApexCodeCoverageAggregate ORDER BY ApexClassOrTrigger.Name");
  const rows = cov.map(c => {
    const cvd = c.NumLinesCovered || 0, unc = c.NumLinesUncovered || 0;
    const total = cvd + unc;
    return { name: c.ApexClassOrTrigger?.Name || c.ApexClassOrTriggerId, covered: cvd, uncovered: unc,
             pct: total ? Math.round(cvd / total * 100) : null };
  }).filter(r => r.name);

  // ApexCodeCoverage is the per-test-class detail behind the aggregate: one row per
  // (test class, covered class) pair, so it tells us which test does the heavy lifting.
  setStatus("Reading which tests cover what…", "busy");
  // ApexCodeCoverage holds one row per test METHOD, not per test class, and the same line is
  // usually covered by several methods. Summing NumLinesCovered therefore counts a line once
  // per method that touched it, which is how a class ended up "1000% covered by" one test.
  // The Coverage field carries the actual line numbers, so the lines are unioned instead.
  const byClass = new Map();
  let exactLines = true;
  try {
    let detail;
    try {
      detail = await toolingQuery(
        "SELECT ApexTestClass.Name, ApexClassOrTrigger.Name, NumLinesCovered, Coverage FROM ApexCodeCoverage");
    } catch (inner) {
      // some orgs refuse the Coverage field; fall back to the largest single run per test
      exactLines = false;
      detail = await toolingQuery(
        "SELECT ApexTestClass.Name, ApexClassOrTrigger.Name, NumLinesCovered FROM ApexCodeCoverage");
    }
    for (const d of detail) {
      const target = d.ApexClassOrTrigger?.Name;
      const test = d.ApexTestClass?.Name;
      if (!target || !test) continue;
      if (!byClass.has(target)) byClass.set(target, new Map());
      const m = byClass.get(target);
      const lines = d.Coverage?.coveredLines;
      if (Array.isArray(lines)) {
        const set = m.get(test) instanceof Set ? m.get(test) : new Set();
        for (const ln of lines) set.add(ln);
        m.set(test, set);
      } else {
        exactLines = false;
        // without line numbers the best honest guess is the biggest single method run,
        // never the sum, so the share can no longer exceed what the class actually has
        m.set(test, Math.max(typeof m.get(test) === "number" ? m.get(test) : 0, d.NumLinesCovered || 0));
      }
    }
  } catch (e) { console.warn("per-test coverage unavailable:", e); }
  for (const r of rows) {
    const m = byClass.get(r.name);
    const counted = m ? [...m.entries()].map(([test, v]) => [test, v instanceof Set ? v.size : v]) : [];
    const ranked = counted.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    r.tests = ranked;                                   // [[testClass, linesCovered], ...]
    r.mainTest = ranked[0] ? ranked[0][0] : null;
    r.mainLines = ranked[0] ? ranked[0][1] : 0;
    r.testCount = ranked.length;
  }

  let fails = [];
  if ($("testsFails").checked) {
    setStatus("Reading recent test failures…", "busy");
    try {
      fails = await toolingQuery(
        "SELECT ApexClass.Name, MethodName, Message, TestTimestamp FROM ApexTestResult " +
        "WHERE Outcome = 'Fail' ORDER BY TestTimestamp DESC LIMIT 200");
    } catch (e) { console.warn("test results unavailable:", e); }
  }
  setStatus("");
  return { rows, fails, exactLines };
}

let coverageRows = [];
function renderCoverage(res) {
  coverageRows = res.rows;
  $("covOverlay").classList.remove("open");
  const only = $("testsBelow").checked;
  const withPct = res.rows.filter(r => r.pct != null);
  const totalCovered = res.rows.reduce((n, r) => n + r.covered, 0);
  const totalLines = res.rows.reduce((n, r) => n + r.covered + r.uncovered, 0);
  const orgPct = totalLines ? Math.round(totalCovered / totalLines * 100) : null;
  const below = withPct.filter(r => r.pct < 75);
  const shown = (only ? below : res.rows).slice().sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));

  $("testsResTitle").textContent = orgPct == null ? "No coverage data" : `Org coverage ${orgPct}%`;
  $("testsResNote").textContent = res.rows.length
    ? "Figures come from the last test run in this org. “Mainly covered by” is the test class contributing the most covered lines, with its share." +
      (res.exactLines === false
        ? " Line-level detail was unavailable, so a test's share is the largest single run rather than its exact distinct lines."
        : "")
    : "No coverage rows, run your Apex tests in this org, then reload.";
  $("testsResSummary").innerHTML =
    (orgPct == null ? "" : `<span class="${orgPct >= 75 ? "e" : "n"}">${orgPct}% org-wide</span>`) +
    `<span class="r">${res.rows.length} classes measured</span>` +
    `<span class="n">${below.length} below 75%</span>` +
    (() => { const orphan = res.rows.filter(r => !r.mainTest).length;
             return orphan ? `<span class="n">${orphan} with no covering test</span>` : ""; })() +
    (res.fails.length ? `<span class="n">${res.fails.length} recent failures</span>` : "");
  $("testsResList").innerHTML = shown.slice(0, 600).map(r => {
    const cls = r.pct == null ? "" : r.pct >= 75 ? "accEdit" : "accNone";
    // covered lines attributed to one test can equal, but never exceed, the class total
    const share = r.mainTest && r.covered
      ? Math.min(100, Math.round(Math.min(r.mainLines, r.covered) / r.covered * 100)) : null;
    const by = r.mainTest
      ? `<a class="pklink" data-cov="${escHtml(r.name)}">${escHtml(r.mainTest)}</a>` +
        `${share != null ? ` <span class="ftype">${share}%</span>` : ""}` +
        (r.testCount > 1 ? ` <a class="pklink" data-cov="${escHtml(r.name)}">+${r.testCount - 1} more</a>` : "")
      : `<span class="accNone">no test</span>`;
    return `<tr><td>${escHtml(r.name)}</td><td>${r.covered}</td><td>${r.uncovered}</td>` +
      `<td class="${cls}">${r.pct == null ? "—" : r.pct + "%"}</td>` +
      `<td>${by}</td>` +
      `<td class="${cls}">${r.pct == null ? "no data" : r.pct >= 75 ? "OK" : "below threshold"}</td></tr>`;
  }).join("") || `<tr><td colspan="5" style="color:var(--faint);">Nothing to show.</td></tr>`;

  if (res.fails.length) {
    $("testsFailTitle").textContent = `${res.fails.length} failed test method${res.fails.length === 1 ? "" : "s"}`;
    $("testsFailList").innerHTML = res.fails.slice(0, 200).map(f =>
      `<tr><td>${escHtml(f.ApexClass?.Name || "")}</td><td>${escHtml(f.MethodName || "")}</td>` +
      `<td class="accNone">${escHtml((f.Message || "").slice(0, 200))}</td>` +
      `<td>${escHtml((f.TestTimestamp || "").replace("T", " ").slice(0, 16))}</td></tr>`).join("");
    $("testsFailBox").style.display = "block";
  } else $("testsFailBox").style.display = "none";
  flashBox("testsResult");
}


// click a "mainly covered by" cell to see every test class that touches that class
function showCoveringTests(className) {
  const r = coverageRows.find(x => x.name === className);
  if (!r) return;
  const tests = r.tests || [];
  $("covTitle").textContent = `${className} · ${tests.length} covering test${tests.length === 1 ? "" : "s"}`;
  $("covNote").textContent = tests.length
    ? `${r.covered} lines covered in total${r.pct == null ? "" : ` (${r.pct}%)`}. Shares are of those covered lines and can overlap when two tests exercise the same line.`
    : "No test class covers this one, so nothing is exercising it, it will hold back your deployment coverage.";
  $("covList").innerHTML = tests.map(([t, n]) => {
    // same clamp as the table: a test cannot cover more lines than the class has covered
    const lines = Math.min(n, r.covered || n);
    const pct = r.covered ? Math.min(100, Math.round(lines / r.covered * 100)) : null;
    return `<tr><td>${escHtml(t)}</td><td>${lines}</td><td>${pct == null ? "—" : pct + "%"}</td></tr>`;
  }).join("")
    || `<tr><td colspan="3" style="color:var(--faint);">Nothing to show.</td></tr>`;
  $("covOverlay").classList.add("open");
}

async function testsShow() {
  const btn = $("testsShowBtn");
  btn.disabled = true;
  try { renderCoverage(await collectCoverage()); }
  catch (err) { setStatus(`Coverage failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function testsExport() {
  const btn = $("testsExportBtn");
  btn.disabled = true;
  try {
    const res = await collectCoverage();
    renderCoverage(res);
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Class / trigger", "Lines covered", "Lines uncovered", "Coverage %",
        "Mainly covered by", "Its share %", "Test classes involved", "Status"],
      ...res.rows.map(r => [r.name, r.covered, r.uncovered, r.pct == null ? "" : r.pct,
        r.mainTest || "(no covering test)",
        r.mainTest && r.covered ? Math.round(r.mainLines / r.covered * 100) : "",
        r.testCount || 0,
        r.pct == null ? "no data" : r.pct >= 75 ? "OK" : "below 75%"])], "Coverage", 60);
    const pairs = [];
    for (const r of res.rows) for (const [t, n] of (r.tests || [])) pairs.push([r.name, t, n]);
    sheetFromRows(wb, pairs.length
      ? [["Class / trigger", "Test class", "Lines it covers"], ...pairs.sort((a, b) => a[0].localeCompare(b[0]) || b[2] - a[2])]
      : [["No per-test coverage rows available"]], "Coverage by Test");
    const orphans = res.rows.filter(r => !r.mainTest);
    sheetFromRows(wb, orphans.length
      ? [["Class / trigger", "Coverage %"], ...orphans.map(r => [r.name, r.pct == null ? "" : r.pct])]
      : [["Every measured class has at least one covering test"]], "No Covering Test");
    const below = res.rows.filter(r => r.pct != null && r.pct < 75);
    sheetFromRows(wb, below.length
      ? [["Class / trigger", "Coverage %"], ...below.sort((a, b) => a.pct - b.pct).map(r => [r.name, r.pct])]
      : [["Nothing below 75%"]], "Below 75");
    if (res.fails.length) sheetFromRows(wb, [["Test class", "Method", "Message", "When"],
      ...res.fails.map(f => [f.ApexClass?.Name || "", f.MethodName || "", f.Message || "",
        (f.TestTimestamp || "").replace("T", " ").slice(0, 19)])], "Failures", 80);
    XLSX.writeFile(wb, `${hostOf(auth)}_coverage_${today()}.xlsx`);
    setStatus("Coverage exported.", "ok");
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- Record counts ----------
async function collectCounts() {
  const objs = (await loadObjectList()).filter(s => !$("countsCustom").checked || s.custom);
  if (!objs.length) throw new Error("No objects match that filter.");
  const rows = [];
  // one cheap COUNT() per object; a few hundred calls, well inside daily limits
  for (let i = 0; i < objs.length; i++) {
    const s = objs[i];
    setProgress(Math.round((i + 1) / objs.length * 100));
    setStatus(`Counting ${s.name}… ${i + 1}/${objs.length}`, "busy");
    try {
      const r = await api(`/query/?q=${encodeURIComponent(`SELECT COUNT() FROM ${s.name}`)}`);
      rows.push({ label: s.label, name: s.name, count: r.totalSize ?? 0, note: "" });
    } catch (e) {
      rows.push({ label: s.label, name: s.name, count: null, note: "not countable" });
    }
  }
  setProgress(null);
  setStatus("");
  rows.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  return { rows };
}

function renderCounts(res) {
  const counted = res.rows.filter(r => r.count != null);
  const total = counted.reduce((n, r) => n + r.count, 0);
  const empty = counted.filter(r => r.count === 0);
  $("countsResTitle").textContent = `${fmt(total)} records across ${counted.length} objects`;
  $("countsResNote").textContent = "Sorted by volume. Objects that reject COUNT() (platform events, big objects, some system objects) are marked not countable.";
  $("countsResSummary").innerHTML =
    `<span class="r">${fmt(total)} records</span><span class="r">${counted.length} counted</span>` +
    ($("countsEmpty").checked ? `<span class="n">${empty.length} empty</span>` : "") +
    `<span class="r">${res.rows.length - counted.length} not countable</span>`;
  $("countsResList").innerHTML = res.rows.slice(0, 800).map(r =>
    `<tr><td>${escHtml(r.label)}</td><td class="mono">${escHtml(r.name)}</td>` +
    `<td>${r.count == null ? "—" : fmt(r.count)}</td>` +
    `<td class="${r.count === 0 ? "accNone" : ""}">${r.count === 0 && $("countsEmpty").checked ? "empty" : escHtml(r.note)}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:var(--faint);">Nothing to show.</td></tr>`;
  flashBox("countsResult");
}

async function countsShow() {
  const btn = $("countsShowBtn");
  btn.disabled = true;
  try { renderCounts(await collectCounts()); }
  catch (err) { setProgress(null); setStatus(`Counting failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function countsExport() {
  const btn = $("countsExportBtn");
  btn.disabled = true;
  try {
    const res = await collectCounts();
    renderCounts(res);
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Object", "API name", "Records", "Note"],
      ...res.rows.map(r => [r.label, r.name, r.count == null ? "" : r.count, r.count === 0 ? "empty" : r.note])], "Record Counts");
    const empty = res.rows.filter(r => r.count === 0);
    sheetFromRows(wb, empty.length ? [["Object", "API name"], ...empty.map(r => [r.label, r.name])]
      : [["No empty objects"]], "Empty Objects");
    XLSX.writeFile(wb, `${hostOf(auth)}_record_counts_${today()}.xlsx`);
    setStatus("Record counts exported.", "ok");
  } catch (err) {
    setProgress(null);
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}


// ---------- copy any result table as TSV, which pastes as a real table ----------
function tableToTsv(box) {
  const out = [];
  for (const tbl of box.querySelectorAll("table")) {
    for (const tr of tbl.querySelectorAll("tr")) {
      const cells = [...tr.querySelectorAll("th,td")].map(td =>
        (td.textContent || "").replace(/\s+/g, " ").trim());
      if (cells.length) out.push(cells.join("\t"));
    }
    out.push("");
  }
  return out.join("\n").trim();
}

// Pasting a table is a clipboard-flavour problem, not a formatting one. TSV alone lands in
// Slack and Teams as a wall of text: Teams renders a table only from text/html, and Slack has
// no tables at all. So a copy carries both flavours, and chat gets its own aligned-text
// button, which is the only thing Slack can render as columns.
function boxTable(box) {
  const tables = [...box.querySelectorAll("table")].filter(t => t.querySelector("tbody tr"));
  return tables[0] || null;
}

function tableCells(table) {
  const rows = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells = [...tr.children].map(td => (td.innerText || "").replace(/\s+/g, " ").trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// a self-contained table, with borders inline so it survives Teams, Word and Confluence
function tableToHtml(table) {
  const rows = tableCells(table);
  if (!rows.length) return "";
  const head = rows[0], body = rows.slice(1);
  const th = head.map(c => `<th style="border:1px solid #b8c4d4;padding:4px 8px;background:#eef3f9;text-align:left">${escHtml(c)}</th>`).join("");
  const trs = body.map(r =>
    `<tr>${r.map(c => `<td style="border:1px solid #d5dde8;padding:4px 8px">${escHtml(c)}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">` +
    `<thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// Slack renders nothing but text, so columns are padded and wrapped in a code fence, which
// is the one shape that stays aligned in a chat window
function tableToAligned(table, maxCell = 34) {
  const rows = tableCells(table).map(r => r.map(c => c.length > maxCell ? c.slice(0, maxCell - 1) + "\u2026" : c));
  if (!rows.length) return "";
  const cols = Math.max(...rows.map(r => r.length));
  const width = [];
  for (let i = 0; i < cols; i++) width[i] = Math.max(...rows.map(r => (r[i] || "").length));
  const line = (r) => r.map((c, i) => (c || "").padEnd(width[i])).join("  ").trimEnd();
  const rule = width.map(w => "-".repeat(w)).join("  ");
  return "```\n" + [line(rows[0]), rule, ...rows.slice(1).map(line)].join("\n") + "\n```";
}

async function writeClipboard(plain, html) {
  // both flavours at once: the receiving app picks the one it understands
  if (html && window.ClipboardItem && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      return true;
    } catch { /* fall through to plain text */ }
  }
  try { await navigator.clipboard.writeText(plain); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = plain; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove();
    return ok;
  }
}

// What "copy" means depends on what the box holds. It used to assume a table, so the panels
// that show source, a diagram or a set of facts copied nothing at all and said so unhelpfully.
function boxCopyText(box) {
  // source code: the lines, without the gutter numbers that would break a paste
  const lines = box.querySelector(".codelines");
  if (lines) {
    return [...lines.querySelectorAll(".ln")]
      .map(r => r.querySelector(".src")?.textContent ?? "").join("\n");
  }
  // a plain source pane, as used by the file list
  const pre = box.querySelector("pre");
  if (pre && pre.textContent.trim()) return pre.textContent;
  // a table, which is the common case
  const tsv = tableToTsv(box);
  if (tsv) return tsv;
  // a diagram: the SVG markup, which pastes into a file or a design tool
  const svg = box.querySelector("svg");
  if (svg) {
    try { return erdStandaloneSvg(); } catch { return svg.outerHTML; }
  }
  // anything else, such as a summary of facts: the readable text, minus our own buttons
  const clone = box.cloneNode(true);
  clone.querySelectorAll(".boxcopy, .boxclose, .mclose, button, input").forEach(el => el.remove());
  const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
  return text || "";
}

async function copyResultBox(id, btn) {
  const box = $(id);
  if (!box) return;
  const table = boxTable(box);
  // A table goes on the clipboard twice: as HTML, which Excel, Teams, Word, Confluence and
  // Jira turn back into a table, and as aligned columns, which is what Slack and any plain
  // text field can actually render. TSV only ever suited spreadsheets, so it is gone.
  const plain = table ? tableToAligned(table) : boxCopyText(box);
  if (!plain) { setStatus("Nothing to copy yet.", "err"); return; }
  const html = table ? tableToHtml(table) : "";
  const label = btn.textContent;
  const ok = await writeClipboard(plain, html);
  if (!ok) { setStatus("The browser refused the clipboard.", "err"); return; }
  if (table) {
    const rows = Math.max(0, tableCells(table).length - 1);      // less the header
    btn.textContent = `Copied ${rows} row${rows === 1 ? "" : "s"}`;
  } else if (/^\s*<(\?xml|svg)/.test(plain)) {
    btn.textContent = "Copied SVG";
  } else {
    const lines = plain.split(/\r?\n/).filter(Boolean).length;
    btn.textContent = `Copied ${lines} line${lines === 1 ? "" : "s"}`;
  }
  setTimeout(() => { btn.textContent = label; }, 1600);
}

// ---------- Scheduled & failed jobs ----------
async function collectJobs() {
  const days = Number($("jobsDays").value);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + "Z";
  setStatus("Reading scheduled jobs…", "busy");
  let sched = [];
  try {
    sched = await stdQuery(
      "SELECT CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, StartTime, " +
      "CreatedBy.Name, TimesTriggered FROM CronTrigger ORDER BY NextFireTime NULLS LAST");
  } catch (e) { console.warn("CronTrigger unavailable:", e); }

  setStatus("Reading job failures…", "busy");
  let failed = [], recent = [];
  try {
    failed = await stdQuery(
      `SELECT Id, JobType, Status, ApexClass.Name, MethodName, NumberOfErrors, TotalJobItems, JobItemsProcessed, ` +
      `ExtendedStatus, CreatedDate, CompletedDate, CreatedBy.Name FROM AsyncApexJob ` +
      `WHERE CreatedDate >= ${since} AND (Status = 'Failed' OR NumberOfErrors > 0) ORDER BY CreatedDate DESC LIMIT 500`);
  } catch (e) { console.warn("AsyncApexJob failures unavailable:", e); }
  try {
    recent = await stdQuery(
      `SELECT Status, COUNT(Id) c FROM AsyncApexJob WHERE CreatedDate >= ${since} GROUP BY Status`);
  } catch (e) { console.warn("AsyncApexJob summary unavailable:", e); }
  setStatus("");
  return { sched, failed, recent, days };
}

const JOB_TYPE = { ScheduledApex: "Scheduled Apex", BatchApex: "Batch Apex", Queueable: "Queueable",
                   Future: "Future method", ApexToken: "Apex token", TestRequest: "Test run",
                   SharingRecalculation: "Sharing recalculation" };

function renderJobs(res) {
  const nice = (t) => JOB_TYPE[t] || t || "";
  const when = (s) => (s || "").replace("T", " ").slice(0, 16);
  const active = res.sched.filter(s => s.State === "WAITING" || s.State === "ACQUIRED");
  const paused = res.sched.filter(s => s.State === "PAUSED" || s.State === "PAUSED_BLOCKED");

  $("jobsResTitle").textContent =
    `${res.sched.length} scheduled · ${res.failed.length} failure${res.failed.length === 1 ? "" : "s"} in ${res.days} day${res.days === 1 ? "" : "s"}`;
  $("jobsResNote").textContent = res.sched.length || res.failed.length
    ? "Scheduled jobs come from CronTrigger; failures from AsyncApexJob, which Salesforce keeps for a limited window."
    : "Nothing scheduled and no failures in range, or this user cannot read job records.";
  const counts = Object.fromEntries(res.recent.map(r => [r.Status, r.c ?? r.expr0 ?? 0]));
  $("jobsResSummary").innerHTML =
    `<span class="r">${active.length} active</span>` +
    (paused.length ? `<span class="n">${paused.length} paused</span>` : "") +
    (counts.Completed ? `<span class="e">${counts.Completed} completed</span>` : "") +
    (counts.Failed ? `<span class="n">${counts.Failed} failed</span>` : "") +
    (counts.Queued ? `<span class="r">${counts.Queued} queued</span>` : "");

  $("jobsSchedTitle").textContent = `${res.sched.length} scheduled job${res.sched.length === 1 ? "" : "s"}`;
  $("jobsSchedList").innerHTML = res.sched.slice(0, 300).map(s => {
    const st = s.State || "";
    const cls = st === "WAITING" || st === "ACQUIRED" ? "accEdit" : st.startsWith("PAUSED") ? "accNone" : "";
    return `<tr><td>${escHtml(s.CronJobDetail?.Name || "")}</td><td>${escHtml(nice(s.CronJobDetail?.JobType))}</td>` +
      `<td class="${cls}">${escHtml(st)}</td><td>${escHtml(when(s.NextFireTime)) || "—"}</td>` +
      `<td>${escHtml(when(s.PreviousFireTime)) || "—"}</td><td>${escHtml(s.CreatedBy?.Name || "")}</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="color:var(--faint);">Nothing scheduled.</td></tr>`;

  $("jobsFailTitle").textContent = `${res.failed.length} failed or errored job${res.failed.length === 1 ? "" : "s"}`;
  $("jobsFailList").innerHTML = res.failed.slice(0, 300).map(f =>
    `<tr><td>${escHtml(f.ApexClass?.Name || f.MethodName || "(none)")}</td><td>${escHtml(nice(f.JobType))}</td>` +
    `<td class="accNone">${escHtml(f.Status || "")}</td>` +
    `<td>${f.NumberOfErrors ?? ""}${f.TotalJobItems ? ` / ${f.JobItemsProcessed ?? 0} of ${f.TotalJobItems}` : ""}</td>` +
    `<td>${escHtml((f.ExtendedStatus || "").slice(0, 200))}</td><td>${escHtml(when(f.CreatedDate))}</td></tr>`).join("")
    || `<tr><td colspan="6" style="color:var(--faint);">No failures in range.</td></tr>`;
  flashBox("jobsResult");
}

async function jobsShow() {
  const btn = $("jobsShowBtn");
  btn.disabled = true;
  try { renderJobs(await collectJobs()); }
  catch (err) { setStatus(`Jobs failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function jobsExport() {
  const btn = $("jobsExportBtn");
  btn.disabled = true;
  try {
    const res = await collectJobs();
    renderJobs(res);
    const when = (s) => (s || "").replace("T", " ").slice(0, 19);
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Job", "Type", "State", "Next run", "Previous run", "Times triggered", "Owner"],
      ...res.sched.map(s => [s.CronJobDetail?.Name || "", JOB_TYPE[s.CronJobDetail?.JobType] || s.CronJobDetail?.JobType || "",
        s.State || "", when(s.NextFireTime), when(s.PreviousFireTime), s.TimesTriggered ?? "", s.CreatedBy?.Name || ""])], "Scheduled", 50);
    sheetFromRows(wb, res.failed.length
      ? [["What ran", "Type", "Status", "Errors", "Processed", "Total", "Message", "Started", "Completed", "Submitted by"],
         ...res.failed.map(f => [f.ApexClass?.Name || f.MethodName || "", JOB_TYPE[f.JobType] || f.JobType || "",
           f.Status || "", f.NumberOfErrors ?? "", f.JobItemsProcessed ?? "", f.TotalJobItems ?? "",
           f.ExtendedStatus || "", when(f.CreatedDate), when(f.CompletedDate), f.CreatedBy?.Name || ""])]
      : [["No failures in range"]], "Failures", 70);
    XLSX.writeFile(wb, `${hostOf(auth)}_jobs_${today()}.xlsx`);
    setStatus(`Exported ${res.sched.length} scheduled and ${res.failed.length} failed jobs.`, "ok");
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- saved SOQL queries ----------
const SOQL_STORE = "soqlSaved";
async function loadSavedQueries() {
  try {
    const got = await new Promise(res => chrome.storage.local.get([SOQL_STORE], v => res(v?.[SOQL_STORE])));
    return Array.isArray(got) ? got : [];
  } catch { return []; }
}
async function putSavedQueries(list) {
  try { await new Promise(res => chrome.storage.local.set({ [SOQL_STORE]: list }, res)); } catch {}
}
async function refreshSavedQueries(selectName) {
  const list = await loadSavedQueries();
  const sel = $("soqlSaved");
  sel.innerHTML = `<option value="">${list.length ? "Pick a saved query" : "No saved queries yet"}</option>` +
    list.map(q => `<option value="${escHtml(q.name)}">${escHtml(q.name)}</option>`).join("");
  if (selectName) sel.value = selectName;
}
async function saveCurrentQuery() {
  const soql = $("soqlText").value.trim();
  if (!soql) return setStatus("Type a query before saving.", "err");
  const name = prompt("Name this query:", soql.slice(0, 40).replace(/\s+/g, " "));
  if (!name) return;
  const list = await loadSavedQueries();
  const existing = list.findIndex(q => q.name === name);
  const entry = { name, soql, tooling: $("soqlTooling").checked };
  if (existing >= 0) list[existing] = entry; else list.push(entry);
  list.sort((a, b) => a.name.localeCompare(b.name));
  await putSavedQueries(list);
  await refreshSavedQueries(name);
  setStatus(`Saved “${name}”.`, "ok");
}
async function deleteSavedQuery() {
  const name = $("soqlSaved").value;
  if (!name) return setStatus("Pick a saved query to delete.", "err");
  const list = (await loadSavedQueries()).filter(q => q.name !== name);
  await putSavedQueries(list);
  await refreshSavedQueries();
  setStatus(`Deleted “${name}”.`, "ok");
}
async function applySavedQuery() {
  const name = $("soqlSaved").value;
  if (!name) return;
  const q = (await loadSavedQueries()).find(x => x.name === name);
  if (!q) return;
  $("soqlText").value = q.soql;
  $("soqlTooling").checked = !!q.tooling;
  setStatus(`Loaded “${name}”, press Run query.`);
}

// ---------- Org compare ----------
const CMP_ATTRS = [
  ["type", "Type"], ["length", "Length"], ["precision", "Precision"], ["scale", "Scale"],
  ["nillable", "Nillable"], ["unique", "Unique"], ["externalId", "External ID"],
  ["calculatedFormula", "Formula"], ["label", "Label"], ["defaultValue", "Default"],
];
function fieldSig(f) { return { ...Object.fromEntries(CMP_ATTRS.map(([k]) => [k, f[k]])),
  referenceTo: (f.referenceTo || []).join(";"),
  picklist: (f.picklistValues || []).filter(v => v.active).map(v => v.value).join(";") }; }

// Component families compared by name, with a few attributes checked for drift.
// std:true → standard REST query; otherwise Tooling. optional:true → silently skipped
// when the entity does not exist in an org (managed features, OmniStudio, …).
const CODE_SPECS = [
  { type: "Apex Class", std: true, soql: "SELECT Name, ApiVersion, Status, LengthWithoutComments FROM ApexClass",
    key: r => r.Name, attrs: { "API version": r => r.ApiVersion, "Status": r => r.Status, "Length": r => r.LengthWithoutComments } },
  { type: "Apex Trigger", std: true, soql: "SELECT Name, ApiVersion, Status, TableEnumOrId FROM ApexTrigger",
    key: r => r.Name, attrs: { "API version": r => r.ApiVersion, "Status": r => r.Status } },
  { type: "Visualforce Page", std: true, soql: "SELECT Name, ApiVersion FROM ApexPage",
    key: r => r.Name, attrs: { "API version": r => r.ApiVersion } },
  { type: "Visualforce Component", std: true, soql: "SELECT Name, ApiVersion FROM ApexComponent",
    key: r => r.Name, attrs: { "API version": r => r.ApiVersion } },
  { type: "LWC Bundle", soql: "SELECT DeveloperName, ApiVersion FROM LightningComponentBundle",
    key: r => r.DeveloperName, attrs: { "API version": r => r.ApiVersion } },
  { type: "Aura Bundle", soql: "SELECT DeveloperName, ApiVersion FROM AuraDefinitionBundle",
    key: r => r.DeveloperName, attrs: { "API version": r => r.ApiVersion } },
  { type: "Static Resource", std: true, soql: "SELECT Name, ContentType FROM StaticResource",
    key: r => r.Name, attrs: { "Content type": r => r.ContentType } },
];
const AUTOMATION_SPECS = [
  { type: "Flow / Process", std: true, soql: "SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventLabel, IsActive FROM FlowDefinitionView",
    key: r => r.ApiName, attrs: { "Active": r => r.IsActive, "Process type": r => r.ProcessType, "Trigger": r => r.TriggerType || "", "Trigger object (label)": r => r.TriggerObjectOrEventLabel || "" } },
  { type: "Workflow Rule", soql: "SELECT Name, TableEnumOrId FROM WorkflowRule", key: r => r.Name, attrs: {} },
];

// OmniStudio keeps its own family: a DataRaptor is a data mapping and a FlexCard is a UI
// component, so neither belongs beside workflow rules. Every entry is optional, since an org
// without OmniStudio has none of these objects at all.
const OMNI_SPECS = [
  { type: "OmniScript / IP", std: true, optional: true, soql: "SELECT Name, Type, SubType, VersionNumber, IsActive FROM OmniProcess",
    key: r => `${r.Name} (${r.Type || ""}/${r.SubType || ""})`, attrs: { "Active": r => r.IsActive, "Version": r => r.VersionNumber } },
  { type: "FlexCard", std: true, optional: true, soql: "SELECT Name, VersionNumber, IsActive FROM OmniUiCard",
    key: r => r.Name, attrs: { "Active": r => r.IsActive, "Version": r => r.VersionNumber } },
  { type: "DataRaptor", std: true, optional: true, soql: "SELECT Name, Type FROM OmniDataTransform",
    key: r => r.Name, attrs: { "Type": r => r.Type } },
];
const PERM_SPECS = [
  { type: "Profile", std: true, soql: "SELECT Name, UserType FROM Profile", key: r => r.Name, attrs: { "User type": r => r.UserType } },
  { type: "Permission Set", std: true, soql: "SELECT Name, Label, IsCustom FROM PermissionSet WHERE IsOwnedByProfile = false",
    key: r => r.Name, attrs: { "Label": r => r.Label } },
  { type: "Permission Set Group", std: true, optional: true, soql: "SELECT DeveloperName, MasterLabel, Status FROM PermissionSetGroup",
    key: r => r.DeveloperName, attrs: { "Status": r => r.Status } },
  { type: "Custom Permission", std: true, optional: true, soql: "SELECT DeveloperName, MasterLabel FROM CustomPermission",
    key: r => r.DeveloperName, attrs: {} },
];
const MISC_SPECS = [
  { type: "Custom Label", soql: "SELECT Name, MasterLabel, Category FROM ExternalString", key: r => r.Name, attrs: { "Category": r => r.Category || "" } },
  { type: "Record Type", std: true, soql: "SELECT SobjectType, DeveloperName, IsActive FROM RecordType",
    key: r => `${r.SobjectType}.${r.DeveloperName}`, attrs: { "Active": r => r.IsActive } },
  { type: "Queue", std: true, soql: "SELECT DeveloperName, Name FROM Group WHERE Type = 'Queue'", key: r => r.DeveloperName, attrs: {} },
  { type: "Report Folder", std: true, optional: true, soql: "SELECT DeveloperName, Name FROM Folder WHERE Type = 'Report'", key: r => r.DeveloperName, attrs: {} },
  { type: "Email Template", std: true, optional: true, soql: "SELECT DeveloperName, Name, IsActive FROM EmailTemplate",
    key: r => r.DeveloperName, attrs: { "Active": r => r.IsActive } },
];

// Compare a family of components across the two connected orgs → diff rows only.
async function compareComponents(specs, label) {
  const diffOnly = $("orgDiffOnly").checked;
  const rows = [["Type", "Component", "Difference", "Attribute", hostOf(auth), hostOf(auth2)]];
  for (const s of specs) {
    setStatus(`Comparing ${label}… (${s.type})`, "busy");
    const run = (a) => s.std ? stdQueryFor(a, s.soql) : toolingQueryFor(a, s.soql);
    let ra, rb;
    try {
      [ra, rb] = await Promise.all([run(auth), run(auth2)]);
    } catch (e) {
      if (!s.optional) rows.push([s.type, "(query failed)", "", "", String(e.message), ""]);
      continue;
    }
    const mapOf = (recs) => {
      const m = new Map();
      for (const r of recs) m.set(s.key(r), r);
      return m;
    };
    const [ma, mb] = [mapOf(ra), mapOf(rb)];
    for (const [k, r] of ma) {
      if (!mb.has(k)) rows.push([s.type, k, `Only in ${hostOf(auth)}`, "", "present", "—"]);
    }
    for (const [k] of mb) {
      if (!ma.has(k)) rows.push([s.type, k, `Only in ${hostOf(auth2)}`, "", "—", "present"]);
    }
    for (const [k, a] of ma) {
      const b = mb.get(k);
      if (!b) continue;
      let anyDiff = false;
      for (const [attr, get] of Object.entries(s.attrs || {})) {
        const va = String(get(a) ?? ""), vb = String(get(b) ?? "");
        if (va !== vb) { anyDiff = true; rows.push([s.type, k, "Differs", attr, va, vb]); }
        else if (!diffOnly) rows.push([s.type, k, "Same", attr, va, vb]);
      }
      // components present in both with no compared attributes still deserve a row
      if (!diffOnly && !anyDiff && !Object.keys(s.attrs || {}).length) {
        rows.push([s.type, k, "Same", "", "present", "present"]);
      }
    }
  }
  return rows.length > 1 ? rows : [...rows, ["(nothing to report)", "", "", "", "", ""]];
}


// A full org diff is thousands of rows across seven sheets, so on screen we show the
// shape of it — how many components differ per area and type — and leave the detail to Excel.
async function showOrgSummary() {
  const btn = $("cmpShowBtn");
  btn.disabled = true;
  try {
    if (!auth2) throw new Error("Pick a second org first.");
    const groups = [
      ["Code", CODE_SPECS], ["Automation", AUTOMATION_SPECS], ["OmniStudio", OMNI_SPECS],
      ["Permissions", PERM_SPECS], ["Other metadata", MISC_SPECS],
    ];
    const rows = [];
    let onlyA = 0, onlyB = 0, differs = 0;
    for (const [area, specs] of groups) {
      const res = await compareComponents(specs, area.toLowerCase());
      const body = res.slice(1).filter(r => r[0] && !String(r[0]).startsWith("("));
      const byType = new Map();
      for (const r of body) {
        const t = r[0], d = String(r[2] || "");
        if (!byType.has(t)) byType.set(t, { a: 0, b: 0, d: 0 });
        const c = byType.get(t);
        if (d.startsWith("Only in " + hostOf(auth))) { c.a++; onlyA++; }
        else if (d.startsWith("Only in")) { c.b++; onlyB++; }
        else if (d === "Differs") { c.d++; differs++; }
      }
      for (const [t, c] of byType) if (c.a || c.b || c.d) rows.push([area, t, c.a, c.b, c.d]);
    }
    $("orgResTitle").textContent = `${hostOf(auth)}  vs  ${hostOf(auth2)}`;
    $("orgResNote").textContent = rows.length
      ? "Counts only, export the workbook for component names and attribute-level detail (objects, fields and rules included)."
      : "No differences found in code, automation, permissions or other metadata.";
    $("orgResSummary").innerHTML =
      `<span class="n">${onlyA} only in ${orgSetupLink(apiHostOf(auth), hostOf(auth))}</span>` +
      `<span class="n">${onlyB} only in ${orgSetupLink(apiHostOf(auth2), hostOf(auth2))}</span>` +
      `<span class="r">${differs} attribute differences</span>`;
    $("orgResList").innerHTML = rows.map(r =>
      `<tr><td>${escHtml(r[0])}</td><td>${escHtml(r[1])}</td>` +
      `<td class="${r[2] ? "accNone" : ""}">${r[2] || ""}</td>` +
      `<td class="${r[3] ? "accNone" : ""}">${r[3] || ""}</td>` +
      `<td class="${r[4] ? "accRead" : ""}">${r[4] || ""}</td></tr>`).join("")
      || `<tr><td colspan="5" style="color:var(--faint);">Nothing to show.</td></tr>`;
    $("mxResult").style.display = "none";
    flashBox("orgResult");
    setStatus("");
  } catch (err) {
    setStatus("Summary failed: " + err.message, "err");
  } finally { btn.disabled = false; }
}

async function runCompare() {
  const btn = $("cmpExportBtn");
  btn.disabled = true;
  try {
    if (!auth2) throw new Error("Pick a second org first.");
    const customOnly = $("cmpCustomOnly").checked;
    setStatus("Listing objects in both orgs…", "busy");
    const filterObjs = (g) => g.sobjects
      .filter(s => s.queryable && !SKIP_SUFFIXES.some(x => s.name.endsWith(x)))
      .filter(s => !customOnly || s.custom)
      .map(s => s.name);
    const [gA, gB] = await Promise.all([apiFor(auth, "/sobjects/"), apiFor(auth2, "/sobjects/")]);
    const namesA = new Set(filterObjs(gA)), namesB = new Set(filterObjs(gB));
    const onlyA = [...namesA].filter(n => !namesB.has(n)).sort();
    const onlyB = [...namesB].filter(n => !namesA.has(n)).sort();
    const common = [...namesA].filter(n => namesB.has(n)).sort();

    const orgDiffOnly = $("orgDiffOnly").checked;
    const objRows = [["Object","Status"]];
    for (const n of onlyA) objRows.push([n, `Only in ${hostOf(auth)}`]);
    for (const n of onlyB) objRows.push([n, `Only in ${hostOf(auth2)}`]);
    if (!orgDiffOnly) for (const n of common) objRows.push([n, "In both"]);

    const [descA, descB] = [
      await describeAllFor(auth, common, `org A (${hostOf(auth)})`),
      await describeAllFor(auth2, common, `org B (${hostOf(auth2)})`),
    ];

    const fRows = [["Object","Field","Difference","Attribute", `${hostOf(auth)} value`, `${hostOf(auth2)} value`]];
    for (const n of common) {
      const fa = new Map((descA[n]?.fields || []).map(f => [f.name, f]));
      const fb = new Map((descB[n]?.fields || []).map(f => [f.name, f]));
      for (const [fn, f] of fa) if (!fb.has(fn)) fRows.push([n, fn, `Only in ${hostOf(auth)}`, "", f.type, ""]);
      for (const [fn, f] of fb) if (!fa.has(fn)) fRows.push([n, fn, `Only in ${hostOf(auth2)}`, "", "", f.type]);
      for (const [fn, f] of fa) {
        const g = fb.get(fn);
        if (!g) continue;
        const sa = fieldSig(f), sb = fieldSig(g);
        for (const k of Object.keys(sa)) {
          const va = String(sa[k] ?? ""), vb = String(sb[k] ?? "");
          if (va !== vb) fRows.push([n, fn, "Differs", k, va.slice(0, 500), vb.slice(0, 500)]);
          else if (!orgDiffOnly) fRows.push([n, fn, "Same", k, va.slice(0, 500), vb.slice(0, 500)]);
        }
      }
    }

    // validation rules diff (existence + active + formula)
    setStatus("Comparing validation rules…", "busy");
    const vRows = [["Object","Rule","Difference", `${hostOf(auth)}`, `${hostOf(auth2)}`]];
    try {
      const commonSet = new Set(common);
      const vq = "SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName FROM ValidationRule";
      const [rA, rB] = await Promise.all([toolingQueryFor(auth, vq), toolingQueryFor(auth2, vq)]);
      const keep = rs => rs.filter(r => commonSet.has(r.EntityDefinition?.QualifiedApiName) ||
                                        onlyA.includes(r.EntityDefinition?.QualifiedApiName) ||
                                        onlyB.includes(r.EntityDefinition?.QualifiedApiName));
      const key = r => `${r.EntityDefinition?.QualifiedApiName}.${r.ValidationName}`;
      const mA = new Map(keep(rA).map(r => [key(r), r])), mB = new Map(keep(rB).map(r => [key(r), r]));
      const both = [];
      for (const [k, r] of mA) {
        if (!mB.has(k)) vRows.push([r.EntityDefinition?.QualifiedApiName, r.ValidationName, `Only in ${hostOf(auth)}`, r.Active ? "Active" : "Inactive", ""]);
        else both.push(k);
      }
      for (const [k, r] of mB) if (!mA.has(k))
        vRows.push([r.EntityDefinition?.QualifiedApiName, r.ValidationName, `Only in ${hostOf(auth2)}`, "", r.Active ? "Active" : "Inactive"]);
      // fetch formulas for rules present in both, compare
      let fdone = 0;
      const fq = [...both];
      async function fworker() {
        while (fq.length) {
          const k = fq.shift();
          const ra = mA.get(k), rb = mB.get(k);
          try {
            const [da, db] = await Promise.all([
              apiFor(auth, `/tooling/sobjects/ValidationRule/${ra.Id}`),
              apiFor(auth2, `/tooling/sobjects/ValidationRule/${rb.Id}`),
            ]);
            const fa = da.Metadata?.errorConditionFormula || "", fb = db.Metadata?.errorConditionFormula || "";
            if (ra.Active !== rb.Active)
              vRows.push([ra.EntityDefinition?.QualifiedApiName, ra.ValidationName, "Active flag differs", ra.Active ? "Active" : "Inactive", rb.Active ? "Active" : "Inactive"]);
            if (fa.trim() !== fb.trim())
              vRows.push([ra.EntityDefinition?.QualifiedApiName, ra.ValidationName, "Formula differs", fa.slice(0, 800), fb.slice(0, 800)]);
          } catch (e) { console.warn("rule compare failed", k, e); }
          fdone++;
          setStatus(`Comparing validation rules… ${fdone}/${both.length}`, "busy");
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, fworker));
    } catch (e) { vRows.push(["(validation rule compare unavailable)", "", String(e.message), "", ""]); }

    // ---- component diffs: code, automation, permission containers, labels ----
    const codeRows = await compareComponents(CODE_SPECS, "code");
    const autoRows = await compareComponents(AUTOMATION_SPECS, "automation");
    const omniRows = await compareComponents(OMNI_SPECS, "OmniStudio");
    const permRows = await compareComponents(PERM_SPECS, "profiles & permission sets");
    const miscRows = await compareComponents(MISC_SPECS, "labels, record types & queues");

    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, objRows.length > 1 ? objRows : [...objRows, ["(no object differences)", ""]], "Objects Diff");
    sheetFromRows(wb, fRows.length > 1 ? fRows : [...fRows, ["(no field differences)", "", "", "", "", ""]], "Fields Diff", 60);
    sheetFromRows(wb, vRows.length > 1 ? vRows : [...vRows, ["(no rule differences)", "", "", "", ""]], "Rules Diff", 70);
    sheetFromRows(wb, codeRows, "Code Diff", 55);
    sheetFromRows(wb, autoRows, "Automation Diff", 55);
    // only worth a sheet where the org actually has OmniStudio
    if (omniRows.length > 1) sheetFromRows(wb, omniRows, "OmniStudio Diff", 55);
    sheetFromRows(wb, permRows, "Permissions Diff", 55);
    sheetFromRows(wb, miscRows, "Other Metadata Diff", 55);
    XLSX.writeFile(wb, `diff_${hostOf(auth)}_vs_${hostOf(auth2)}_${today()}.xlsx`);
    setStatus(`Done, objects ${objRows.length - 1} · fields ${fRows.length - 1} · rules ${vRows.length - 1} · code ${codeRows.length - 1} · automation ${autoRows.length - 1}` + (omniRows.length > 1 ? ` · OmniStudio ${omniRows.length - 1}` : "") + ` · permissions ${permRows.length - 1} · other ${miscRows.length - 1} differences.`, "ok");
  } catch (e) {
    setStatus(`Compare failed: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}


// ---------- permissions panel object picker ----------
const permSel = new Set();
let permInited = false;

async function initPerms() {
  if (permInited) return;
  try {
    setStatus("Loading object list…", "busy");
    await loadObjectList();
    permInited = true;
    setStatus("");
    renderPermList();
  } catch (e) { setStatus(`Could not load objects: ${e.message}`, "err"); }
}

function renderPermList() {
  const q = $("permSearch").value.trim().toLowerCase();
  const list = (allObjects || [])
    .filter(s => !q || s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .slice(0, 300);
  $("permList").innerHTML = list.map(s =>
    `<label><input type="checkbox" data-pobj="${escHtml(s.name)}" ${permSel.has(s.name) ? "checked" : ""}>` +
    `${hl(s.label, q)}<span class="api">${hl(s.name, q)}</span></label>`).join("")
    || `<div style="padding:10px; font-size:13px; color:var(--faint);">No objects match.</div>`;
  $("permCount").textContent = `${permSel.size} selected`;
}

function permObjectList() {
  if (!permSel.size) throw new Error("Tick at least one object in the list.");
  if (permSel.size > 20) throw new Error("Maximum 20 objects at a time.");
  return [...permSel];
}

// show object CRUD on screen (no download)
async function showPerms() {
  const btn = $("permsShowBtn");
  btn.disabled = true;
  try {
    const objs = permObjectList();
    const psFilter = $("permIncludePS").checked ? "" : " AND Parent.IsOwnedByProfile = true";
    setStatus("Querying object permissions…", "busy");
    const op = await stdQuery(
      `SELECT Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, SobjectType, ` +
      `PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords ` +
      `FROM ObjectPermissions WHERE SobjectType IN (${soqlIn(objs)})${psFilter} ORDER BY SobjectType`);
    setStatus("");
    const who = r => r.Parent?.IsOwnedByProfile ? (r.Parent?.Profile?.Name || r.Parent?.Label) : r.Parent?.Label;
    const kind = r => r.Parent?.IsOwnedByProfile ? "Profile" : "Permission Set";
    const yn = (v) => v ? `<td class="accEdit">✓</td>` : `<td class="accNone">✕</td>`;
    $("permResTitle").textContent = objs.join(", ");
    $("permResNote").textContent = op.length
      ? "Rows are grants that exist; ✕ marks a permission not granted by that profile / permission set."
      : "No object-permission records found for the selected objects.";
    const profiles = new Set(op.filter(r => r.Parent?.IsOwnedByProfile).map(who));
    const sets = new Set(op.filter(r => !r.Parent?.IsOwnedByProfile).map(who));
    $("permResSummary").innerHTML =
      `<span class="r">${profiles.size} profile${profiles.size === 1 ? "" : "s"}</span>` +
      `<span class="r">${sets.size} permission set${sets.size === 1 ? "" : "s"}</span>` +
      `<span class="e">${op.filter(r => r.PermissionsEdit).length} with edit</span>` +
      `<span class="n">${op.filter(r => r.PermissionsModifyAllRecords).length} with modify all</span>`;
    $("permResList").innerHTML = op.map(r =>
      `<tr><td>${escHtml(r.SobjectType)}</td><td>${escHtml(who(r))}</td><td>${kind(r)}</td>` +
      yn(r.PermissionsRead) + yn(r.PermissionsCreate) + yn(r.PermissionsEdit) +
      yn(r.PermissionsDelete) + yn(r.PermissionsViewAllRecords) + yn(r.PermissionsModifyAllRecords) +
      `</tr>`).join("") || `<tr><td colspan="9" style="color:var(--faint);">Nothing to show.</td></tr>`;
    const box = $("permResult");
    box.style.display = "block";
    box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    setStatus(`Could not load permissions: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}


// ---------- multi-org matrix ----------
// The row set is the UNION of components across every selected org, so something that
// exists only in a sandbox is as visible as something missing from it. The reference org
// is only the yardstick for value comparison, never the source of the rows.
let mxSlots = [];              // hosts in slot order: [A, B, C, ...]
let mxAllOrgs = [];
let mxRows = [], mxOrgs = [], mxBaseName = "";

async function loadMxOrgs() {
  mxAllOrgs = await cmpOrgs();
  const mine = auth ? apiHostOf(auth) : "";
  mxSlots = mxSlots.filter(h => h && h !== mine);
  if (!mxSlots.length) {
    const next = mxAllOrgs.find(o => o.host !== mine);
    if (next) mxSlots = [next.host];
  }
  renderMxSlots();
}

function renderMxSlots() {
  const mine = auth ? apiHostOf(auth) : "";
  const used = new Set([mine, ...mxSlots]);
  const rows = [`<div class="mxslot fixed">
    <span class="tag">A</span>
    <span class="who">${escHtml(mxLabel(mine))}</span>
    <span class="note">(the org you are signed into, used as the reference)</span>
  </div>`];
  mxSlots.forEach((host, i) => {
    const letter = String.fromCharCode(66 + i);
    const opts = mxAllOrgs.filter(o => o.host !== mine).map(o =>
      `<option value="${escHtml(o.host)}" ${o.host === host ? "selected" : ""} ` +
      `${used.has(o.host) && o.host !== host ? "disabled" : ""}>${escHtml(o.label)}</option>`).join("");
    rows.push(`<div class="mxslot">
      <span class="tag">${letter}</span>
      <select data-slot="${i}">${opts || '<option value="">No other logged-in org found</option>'}</select>
      ${mxSlots.length > 1 ? `<button class="drop" data-drop="${i}" title="Remove this org">&times;</button>` : ""}
    </div>`);
  });
  $("mxSlots").innerHTML = rows.join("");
  const spare = mxAllOrgs.filter(o => o.host !== mine && !mxSlots.includes(o.host)).length;
  $("mxAdd").style.display = (spare > 0 && mxSlots.length < 7) ? "inline" : "none";
  $("mxSlotHint").textContent = spare > 0
    ? `(${spare} more logged-in org${spare === 1 ? "" : "s"} you could add)`
    : (mxAllOrgs.length > 1 ? "(every org you are logged into is listed)"
                            : "(log into another org in a new tab, then refresh)");
  const many = mxSlots.filter(Boolean).length > 1;
  $("cmpShowLabel").textContent = many ? "Show matrix" : "Show summary";
  $("cmpExportLabel").textContent = many ? "Export matrix" : "Export org diff";
}

function mxLabel(host) {
  return mxAllOrgs.find(o => o.host === host)?.label || host || "this org";
}

// one org added = the detailed A vs B diff; more than one = the matrix
async function cmpShow() {
  if (mxSlots.filter(Boolean).length > 1) return mxShow();
  await useSecondOrg();
  return showOrgSummary();
}

async function cmpExport() {
  if (mxSlots.filter(Boolean).length > 1) return mxExport();
  await useSecondOrg();
  return runCompare();
}

// point auth2 at slot B before the two-org paths run
async function useSecondOrg() {
  const host = mxSlots[0];
  if (!host) throw new Error("Pick a second org first.");
  if (auth2 && apiHostOf(auth2) === host) return;
  setStatus("Opening the second org's session…", "busy");
  const r = await ask({ type: "session", host });
  if (!r?.ok) throw new Error(r?.error || "Could not read that org's session.");
  auth2 = { accessToken: r.session.token, instanceUrl: `https://${host}` };
  setStatus("");
}

const MX_FAMILIES = () => [
  ["Code", CODE_SPECS], ["Automation", AUTOMATION_SPECS],
  ["Permissions", PERM_SPECS], ["Other metadata", MISC_SPECS],
];

async function collectMatrix() {
  const hosts = [apiHostOf(auth), ...mxSlots.filter(Boolean)];
  if (hosts.length < 2) throw new Error("Add at least one other org.");
  if (new Set(hosts).size !== hosts.length) throw new Error("The same org is selected twice; change one of the slots.");
  if (hosts.length > 8) throw new Error("Maximum eight orgs at once; the table scrolls sideways beyond that.");
  const base = hosts[0];
  const withObjects = $("mxScope").value === "objects";

  // one session per org, fetched on demand
  const sessions = [];
  for (const host of hosts) sessions.push({ host, auth: await sessionForHost(host) });
  const label = (h) => (mxOrgs.find(o => o.host === h)?.label) || h.split(".")[0];

  // key -> { type, name, values: Map(host -> value) }
  const rows = new Map();
  const put = (type, name, host, value) => {
    const k = `${type}|${name}`;
    if (!rows.has(k)) rows.set(k, { type, name, values: new Map() });
    rows.get(k).values.set(host, value);
  };

  const families = MX_FAMILIES();
  let step = 0;
  const totalSteps = sessions.length * (families.reduce((n, f) => n + f[1].length, 0) + (withObjects ? 1 : 0));

  for (const s of sessions) {
    if (withObjects) {
      setStatus(`Listing objects in ${label(s.host)}…`, "busy");
      try {
        const g = await apiFor(s.auth, "/sobjects/");
        for (const o of g.sobjects || []) {
          if (!o.queryable || SKIP_SUFFIXES.some(x => o.name.endsWith(x))) continue;
          if (!o.custom) continue;                       // custom objects only: standard is noise
          put("Custom object", o.name, s.host, "present");
        }
      } catch (e) { console.warn("object list failed for", s.host, e); }
      setProgress(Math.round(++step / totalSteps * 100));
    }
    for (const [family, specs] of families) {
      for (const spec of specs) {
        setStatus(`Reading ${spec.type} in ${label(s.host)}…`, "busy");
        try {
          const recs = await (spec.std ? stdQueryFor(s.auth, spec.soql) : toolingQueryFor(s.auth, spec.soql));
          for (const r of recs) {
            const name = spec.key(r);
            if (!name) continue;
            // a compact signature of the attributes we track, so "differs" is meaningful
            const attrs = Object.entries(spec.attrs || {}).map(([k, get]) => `${k}=${get(r) ?? ""}`);
            put(spec.type, name, s.host, attrs.length ? attrs.join(", ") : "present");
          }
        } catch (e) {
          if (!spec.opt) console.warn(spec.type, "failed for", s.host, e);
        }
        setProgress(Math.round(++step / totalSteps * 100));
      }
    }
  }

  // classify each row against the union
  const out = [];
  for (const { type, name, values } of rows.values()) {
    const present = hosts.filter(h => values.has(h));
    const missing = hosts.filter(h => !values.has(h));
    const distinct = new Set(present.map(h => values.get(h)));
    let status;
    if (missing.length === 0) status = distinct.size === 1 ? "Same everywhere" : "Value differs";
    else if (present.length === 1) status = `Only in ${label(present[0])}`;
    else status = `Missing in ${missing.map(label).join(", ")}` + (distinct.size > 1 ? ", and values differ" : "");
    out.push({ type, name, values, status,
               baseValue: values.get(base) ?? null, missing, present });
  }
  out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  setProgress(null);
  setStatus("");
  mxOrgs = sessions.map(s => ({ host: s.host, label: label(s.host) }));
  mxBaseName = label(base);
  mxRows = out;
  return { rows: out, hosts, base };
}

// An org-compare row is a component seen in several orgs, so there is no single record to
// open. The org itself is the useful destination: each column heading opens that org's Setup
// in a new tab, which is how you get from "only in uat" to actually looking at uat.
function orgSetupLink(host, label) {
  return `<a href="${escHtml(setupUrl.home(host))}" target="_blank" ` +
    `rel="noopener" title="Open Setup in ${escHtml(host)}">${escHtml(label)}</a>`;
}

function renderMatrix() {
  const diffOnly = $("orgDiffOnly").checked;
  const q = $("mxFilter").value.trim().toLowerCase();
  const rows = mxRows
    .filter(r => !diffOnly || r.status !== "Same everywhere")
    .filter(r => !q || `${r.type} ${r.name} ${r.status}`.toLowerCase().includes(q));

  $("mxHead").innerHTML = `<tr><th>Type</th><th>Component</th>` +
    mxOrgs.map((o, i) => `<th>${String.fromCharCode(65 + i)} · ${orgSetupLink(o.host, o.label)}` +
      `${o.label === mxBaseName ? ' <span class="ftype">reference</span>' : ""}</th>`).join("") +
    `<th>Status</th></tr>`;
  $("mxBody").innerHTML = rows.slice(0, 600).map(r => {
    const cells = mxOrgs.map(o => {
      const v = r.values.get(o.host);
      if (v == null) return `<td class="accNone">absent</td>`;
      const differs = r.baseValue != null && v !== r.baseValue;
      return `<td class="${differs ? "accRead" : ""}" title="${escHtml(String(v))}">` +
             `${escHtml(String(v).slice(0, 40))}${String(v).length > 40 ? "…" : ""}</td>`;
    }).join("");
    const cls = r.status === "Same everywhere" ? "accEdit"
              : r.status.startsWith("Only in") ? "accRead" : "accNone";
    return `<tr><td>${escHtml(r.type)}</td><td>${hl(r.name, q)}</td>${cells}` +
           `<td class="${cls}">${escHtml(r.status)}</td></tr>`;
  }).join("") || `<tr><td colspan="${mxOrgs.length + 3}" style="color:var(--faint);">Nothing to show.</td></tr>`;

  const missing = mxRows.filter(r => r.missing.length && r.present.length > 1).length;
  const only = mxRows.filter(r => r.present.length === 1).length;
  const differs = mxRows.filter(r => r.status === "Value differs").length;
  const same = mxRows.filter(r => r.status === "Same everywhere").length;
  $("mxResTitle").textContent = `${mxOrgs.length} orgs · ${mxRows.length} components`;
  $("mxResNote").textContent = rows.length
    ? `Rows are the union across all orgs, so a component that exists in only one of them appears too. Values are compared against ${mxBaseName}.`
    : "Nothing matches the current filter.";
  $("mxResSummary").innerHTML =
    `<span class="e">${same} same everywhere</span>` +
    `<span class="n">${missing} missing somewhere</span>` +
    `<span class="r">${only} in one org only</span>` +
    `<span class="r">${differs} value differences</span>`;
  if (rows.length > 600) $("mxResNote").textContent += ` Showing the first 600 of ${rows.length}.`;
  $("orgResult").style.display = "none";
  flashBox("mxResult");
}

async function mxShow() {
  const btn = $("cmpShowBtn");
  btn.disabled = true;
  try { await collectMatrix(); renderMatrix(); }
  catch (err) { setProgress(null); setStatus(`Matrix failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function mxExport() {
  const btn = $("cmpExportBtn");
  btn.disabled = true;
  try {
    await collectMatrix();
    renderMatrix();
    const header = ["Type", "Component", ...mxOrgs.map(o => o.label + (o.label === mxBaseName ? " (reference)" : "")), "Status"];
    const body = mxRows.map(r => [r.type, r.name,
      ...mxOrgs.map(o => r.values.has(o.host) ? String(r.values.get(o.host)) : ""), r.status]);
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [header, ...body], "Matrix", 60);
    const notSame = body.filter((_, i) => mxRows[i].status !== "Same everywhere");
    sheetFromRows(wb, notSame.length ? [header, ...notSame] : [["Every component is identical across these orgs"]], "Differences", 60);
    const gaps = mxRows.filter(r => r.missing.length);
    sheetFromRows(wb, gaps.length
      ? [["Type", "Component", "Present in", "Missing from"],
         ...gaps.map(r => [r.type, r.name, r.present.map(h => mxOrgs.find(o => o.host === h)?.label).join(", "),
                           r.missing.map(h => mxOrgs.find(o => o.host === h)?.label).join(", ")])]
      : [["No component is missing from any org"]], "Gaps");
    sheetFromRows(wb, [["Orgs compared", mxOrgs.map(o => o.label).join(", ")],
      ["Reference", mxBaseName], ["Components", mxRows.length], ["Generated", today()],
      ["Note", "Rows are the union across all orgs: components present in only one org are included."]], "About");
    XLSX.writeFile(wb, `org_matrix_${mxOrgs.length}orgs_${today()}.xlsx`);
    setStatus(`Exported ${mxRows.length} components across ${mxOrgs.length} orgs.`, "ok");
  } catch (err) {
    setProgress(null);
    setStatus(`Export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- Permissions matrix ----------
function parseObjList(id, max) {
  const list = $(id).value.split(",").map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("Enter at least one object API name.");
  if (list.length > max) throw new Error(`Maximum ${max} objects at a time.`);
  return list;
}
const soqlIn = (list) => list.map(o => `'${o.replace(/'/g, "")}'`).join(",");

async function runPerms() {
  const btn = $("permsBtn");
  btn.disabled = true;
  try {
    const objs = permObjectList();
    const inc = $("permIncludePS").checked;
    setStatus("Querying object permissions…", "busy");
    const psFilter = inc ? "" : " AND Parent.IsOwnedByProfile = true";
    const op = await stdQuery(
      `SELECT Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, SobjectType, ` +
      `PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords ` +
      `FROM ObjectPermissions WHERE SobjectType IN (${soqlIn(objs)})${psFilter} ORDER BY SobjectType`);
    setStatus("Querying field permissions…", "busy");
    const fp = await stdQuery(
      `SELECT Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, SobjectType, Field, PermissionsRead, PermissionsEdit ` +
      `FROM FieldPermissions WHERE SobjectType IN (${soqlIn(objs)})${psFilter} ORDER BY SobjectType, Field`);

    const who = r => r.Parent?.IsOwnedByProfile ? (r.Parent?.Profile?.Name || r.Parent?.Label) : r.Parent?.Label;
    const kind = r => r.Parent?.IsOwnedByProfile ? "Profile" : "Permission Set";

    const opRows = [["Object","Profile / Perm Set","Type","Read","Create","Edit","Delete","View All","Modify All"]];
    for (const r of op) opRows.push([r.SobjectType, who(r), kind(r),
      r.PermissionsRead ? "Yes" : "", r.PermissionsCreate ? "Yes" : "", r.PermissionsEdit ? "Yes" : "",
      r.PermissionsDelete ? "Yes" : "", r.PermissionsViewAllRecords ? "Yes" : "", r.PermissionsModifyAllRecords ? "Yes" : ""]);

    const fpRows = [["Object","Field","Profile / Perm Set","Type","Access"]];
    for (const r of fp) fpRows.push([r.SobjectType, r.Field, who(r), kind(r),
      r.PermissionsEdit ? "Edit" : r.PermissionsRead ? "Read" : "None"]);

    // matrix: rows = Object.Field, cols = profiles only
    const profiles = [...new Set(fp.filter(r => r.Parent?.IsOwnedByProfile).map(who))].sort();
    const byField = new Map();
    for (const r of fp.filter(r => r.Parent?.IsOwnedByProfile)) {
      const k = r.Field;
      if (!byField.has(k)) byField.set(k, {});
      byField.get(k)[who(r)] = r.PermissionsEdit ? "Edit" : r.PermissionsRead ? "Read" : "—";
    }
    const mxRows = [["Field", ...profiles]];
    for (const [f, row] of [...byField.entries()].sort()) mxRows.push([f, ...profiles.map(p => row[p] || "—")]);

    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, opRows, "Object CRUD");
    sheetFromRows(wb, fpRows, "FLS");
    sheetFromRows(wb, mxRows.length > 1 ? mxRows : [...mxRows, ["(no FLS rows returned)"]], "FLS Matrix (Profiles)", 40);
    XLSX.writeFile(wb, `${hostOf(auth)}_permissions_${today()}.xlsx`);
    setStatus(`Done, ${op.length} object-permission rows, ${fp.length} FLS rows across ${objs.length} objects.`, "ok");
  } catch (e) {
    setStatus(`Permissions export failed: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- Automation inventory ----------
async function runAuto() {
  const btn = $("autoBtn");
  btn.disabled = true;
  try {
    const rows = await collectAutomationRows(autoFilterSet());
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, rows.length > 1 ? rows : [...rows, ["(no automation found)", "", "", "", "", ""]], "Automation", 60);
    XLSX.writeFile(wb, `${hostOf(auth)}_automation_${today()}.xlsx`);
    setStatus(`Done, ${rows.length - 1} automation entries.`, "ok");
  } catch (e) {
    setStatus(`Automation export failed: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}

async function collectAutomationRows(filterSet) {
  {
    // The picker selects objects by API name, but some metadata reports its object as a
    // label (flows) or an id (triggers/workflow rules). So expand each SELECTED object
    // into exactly its own aliases — API name + that object's label — instead of matching
    // labels globally, which could collide with a different object's label.
    let aliasSet = filterSet;
    if (filterSet.size) {
      aliasSet = new Set(filterSet);
      try {
        for (const s of await loadObjectList()) {
          if (filterSet.has(s.name.toLowerCase()) || filterSet.has(String(s.label).toLowerCase())) {
            aliasSet.add(s.name.toLowerCase());
            if (s.label) aliasSet.add(String(s.label).toLowerCase());
          }
        }
      } catch { /* keep the raw selection */ }
    }
    const wants = (...aliases) => {
      if (!aliasSet.size) return true;
      return aliases.some(a => a && aliasSet.has(String(a).toLowerCase()));
    };

    setStatus("Mapping custom object IDs…", "busy");
    let idMap = new Map();
    try {
      const cos = await toolingQuery("SELECT Id, DeveloperName FROM CustomObject");
      idMap = new Map(cos.map(r => [r.Id, `${r.DeveloperName}__c`]));
      idMap = new Map([...idMap, ...[...idMap].map(([id, n]) => [id.slice(0, 15), n])]);
    } catch (e) { console.warn("CustomObject map failed:", e); }
    const objName = (t) => /^[a-zA-Z0-9]{15,18}$/.test(t) && idMap.has(t) ? idMap.get(t) : t;

    const rows = [["Object","Automation Type","Name","Active","Events / Trigger","Details"]];

    setStatus("Fetching Apex triggers…", "busy");
    try {
      const trs = await toolingQuery(
        "SELECT Name, TableEnumOrId, Status, UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger");
      for (const t of trs) {
        const obj = objName(t.TableEnumOrId);
        if (!wants(obj, t.TableEnumOrId)) continue;
        const ev = [
          t.UsageBeforeInsert && "before insert", t.UsageAfterInsert && "after insert",
          t.UsageBeforeUpdate && "before update", t.UsageAfterUpdate && "after update",
          t.UsageBeforeDelete && "before delete", t.UsageAfterDelete && "after delete",
          t.UsageAfterUndelete && "after undelete",
        ].filter(Boolean).join(", ");
        rows.push([obj, "Apex Trigger", t.Name, t.Status === "Active" ? "Yes" : "No", ev, ""]);
      }
    } catch (e) { rows.push(["", "Apex Trigger", "(query failed)", "", "", String(e.message)]); }

    setStatus("Fetching flows & process builders…", "busy");
    try {
      // FlowDefinitionView exposes the trigger object as a LABEL; resolve it to the API
      // name so rows match the rest of the sheet and the object filter actually works.
      // TriggerObjectOrEventId is an EntityDefinition durable id when present.
      const entityById = new Map();
      const apiByLabel = new Map();
      // describe-global first: always available, gives label -> API name
      try {
        for (const s of await loadObjectList()) if (!apiByLabel.has(s.label)) apiByLabel.set(s.label, s.name);
      } catch { /* non-fatal */ }
      // EntityDefinition adds the durable-id mapping (Tooling is where it is queryable)
      for (const runner of [toolingQuery, stdQuery]) {
        try {
          const entityRows = runner === toolingQuery
            ? await entityDefQuery("DurableId, QualifiedApiName, Label")
            : await runner("SELECT DurableId, QualifiedApiName, Label FROM EntityDefinition");
          for (const e of entityRows) {
            if (e.DurableId) entityById.set(e.DurableId, e.QualifiedApiName);
            if (e.Label && !apiByLabel.has(e.Label)) apiByLabel.set(e.Label, e.QualifiedApiName);
          }
          break;
        } catch (e) { console.warn("EntityDefinition lookup failed:", e); }
      }
      let flows = null, flowErr = "";
      const flowQueries = [
        "SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventId, TriggerObjectOrEventLabel, IsActive FROM FlowDefinitionView",
        "SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventLabel, IsActive FROM FlowDefinitionView",
        "SELECT ApiName, Label, ProcessType, IsActive FROM FlowDefinitionView",
      ];
      for (const q of flowQueries) {
        try { flows = await stdQuery(q); flowErr = ""; break; }
        catch (e) { flowErr = String(e.message); }
      }
      if (!flows) {
        // last resort: the Tooling FlowDefinition list (no trigger detail, but at least visible)
        try {
          const defs = await toolingQuery("SELECT DeveloperName, ActiveVersionId FROM FlowDefinition");
          flows = defs.map(d => ({ ApiName: d.DeveloperName, Label: d.DeveloperName, ProcessType: "Flow",
            TriggerType: null, TriggerObjectOrEventLabel: "", IsActive: !!d.ActiveVersionId }));
          flowErr = "";
        } catch (e) { flowErr = flowErr || String(e.message); }
      }
      if (!flows) {
        rows.push(["", "Flow", "(could not read flows)", "", "", flowErr]);
        flows = [];
      }
      const typeName = (p, t) =>
        p === "Workflow" ? "Process Builder" :
        p === "AutoLaunchedFlow" ? (t ? "Record-Triggered Flow" : "Autolaunched Flow") :
        p === "Flow" ? "Screen Flow" : p;
      for (const f of flows) {
        const label = f.TriggerObjectOrEventLabel || "";
        const obj = entityById.get(f.TriggerObjectOrEventId) || apiByLabel.get(label) || label;
        if (!wants(obj, label)) continue;
        rows.push([obj, typeName(f.ProcessType, f.TriggerType), `${f.Label} (${f.ApiName})`,
          f.IsActive ? "Yes" : "No", f.TriggerType || "", f.ProcessType]);
      }
    } catch (e) { rows.push(["", "Flow", "(query failed)", "", "", String(e.message)]); }

    setStatus("Fetching workflow rules…", "busy");
    try {
      const wrs = await toolingQuery("SELECT Name, TableEnumOrId FROM WorkflowRule");
      for (const w of wrs) {
        const obj = objName(w.TableEnumOrId);
        if (!wants(obj, w.TableEnumOrId)) continue;
        rows.push([obj, "Workflow Rule", w.Name, "", "", ""]);
      }
    } catch (e) { console.warn("workflow rules skipped:", e); }

    return rows;
  }
}


// ---------- Metadata API (SOAP) ----------
// REST and Tooling can only tell us about the types they happen to expose. The Metadata
// API can enumerate every type the org supports, with a last-modified stamp and author per
// component, which is the only way to build a manifest that is actually complete. It speaks
// SOAP, so this is XML in and XML out; no library is involved.
const MD_API_VERSION = "61.0";

function mdEnvelope(token, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns="http://soap.sforce.com/2006/04/metadata">` +
    `<soapenv:Header><SessionHeader><sessionId>${escXml(token)}</sessionId></SessionHeader></soapenv:Header>` +
    `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function mdCall(a, body) {
  const res = await fetch(`${baseUrl(a)}/services/Soap/m/${MD_API_VERSION}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: "''" },
    body: mdEnvelope(a.accessToken, body),
  });
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  // a SOAP fault comes back with HTTP 500, so the status alone is not the signal
  const fault = doc.getElementsByTagName("faultstring")[0];
  if (fault) throw new Error(fault.textContent || "Metadata API refused the call");
  if (!res.ok) throw new Error(`Metadata API returned ${res.status}`);
  return doc;
}

const mdText = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent || "";

// Every type this org's API version knows about, plus the child types (CustomField,
// ValidationRule and friends) which are listed separately even though they live inside
// their parent's file.
async function mdDescribeTypes(a) {
  const doc = await mdCall(a, `<describeMetadata><asOfVersion>${MD_API_VERSION}</asOfVersion></describeMetadata>`);
  const out = [];
  for (const m of doc.getElementsByTagName("metadataObjects")) {
    const xmlName = mdText(m, "xmlName");
    if (!xmlName) continue;
    out.push({ name: xmlName, inFolder: mdText(m, "inFolder") === "true", child: false });
    for (const c of m.getElementsByTagName("childXmlNames")) {
      if (c.textContent) out.push({ name: c.textContent, inFolder: false, child: true });
    }
  }
  // de-duplicate: a child type can be declared under more than one parent
  const seen = new Set();
  return out.filter(t => !seen.has(t.name) && seen.add(t.name));
}

// listMetadata takes at most three queries per call, which is the reason this is the slow
// part: a full org means dozens of round trips.
async function mdListChunk(a, queries) {
  const body = `<listMetadata>` +
    queries.map(q => `<queries><type>${escXml(q.type)}</type>` +
      (q.folder ? `<folder>${escXml(q.folder)}</folder>` : "") + `</queries>`).join("") +
    `<asOfVersion>${MD_API_VERSION}</asOfVersion></listMetadata>`;
  const doc = await mdCall(a, body);
  const rows = [];
  for (const r of doc.getElementsByTagName("result")) {
    const type = mdText(r, "type");
    if (!type) continue;
    rows.push({
      type,
      fullName: mdText(r, "fullName"),
      fileName: mdText(r, "fileName"),
      lastModified: mdText(r, "lastModifiedDate"),
      lastModifiedBy: mdText(r, "lastModifiedByName"),
      createdDate: mdText(r, "createdDate"),
      manageableState: mdText(r, "manageableState") || "unpackaged",
      namespace: mdText(r, "namespacePrefix"),
    });
  }
  return rows;
}

// Folder types cannot be listed in one go: you list the folders, then each folder's contents.
const MD_FOLDER_TYPES = { Report: "ReportFolder", Dashboard: "DashboardFolder",
  EmailTemplate: "EmailFolder", Document: "DocumentFolder" };

let mdRows = [], mdSkipped = [];

async function collectAllMetadata() {
  const a = auth;
  setStatus("Asking the org which metadata types it supports…", "busy");
  setProgress(2, "describeMetadata");
  const types = await mdDescribeTypes(a);

  const plain = [], folders = [];
  for (const t of types) {
    if (MD_FOLDER_TYPES[t.name]) folders.push(t.name);
    else if (Object.values(MD_FOLDER_TYPES).includes(t.name)) folders.push(t.name);   // list the folders themselves too
    else plain.push(t.name);
  }

  mdRows = [];
  mdSkipped = [];
  const queries = plain.map(type => ({ type }));
  for (const f of folders) queries.push({ type: f });

  // three per call, a few calls at a time: enough to be quick without tripping limits
  const chunks = [];
  for (let i = 0; i < queries.length; i += 3) chunks.push(queries.slice(i, i + 3));
  let done = 0;
  const CONC = 4;
  async function worker() {
    while (chunks.length) {
      const chunk = chunks.shift();
      try { mdRows.push(...await mdListChunk(a, chunk)); }
      catch (err) { mdSkipped.push({ types: chunk.map(c => c.type).join(", "), reason: err.message }); }
      done++;
      setProgress(2 + (done / (done + chunks.length)) * 70, `Listing components (${mdRows.length} so far)`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // second pass for anything that lives in a folder
  const folderNames = {};
  for (const [type, folderType] of Object.entries(MD_FOLDER_TYPES)) {
    folderNames[type] = mdRows.filter(r => r.type === folderType).map(r => r.fullName);
  }
  const folderQueries = [];
  for (const [type, names] of Object.entries(folderNames)) {
    for (const folder of names) folderQueries.push({ type, folder });
  }
  const fChunks = [];
  for (let i = 0; i < folderQueries.length; i += 3) fChunks.push(folderQueries.slice(i, i + 3));
  let fDone = 0;
  async function fWorker() {
    while (fChunks.length) {
      const chunk = fChunks.shift();
      try { mdRows.push(...await mdListChunk(a, chunk)); }
      catch (err) { mdSkipped.push({ types: chunk.map(c => `${c.type} in ${c.folder}`).join(", "), reason: err.message }); }
      fDone++;
      setProgress(72 + (fDone / (fDone + fChunks.length)) * 24, `Listing folder contents (${mdRows.length} components)`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, fWorker));

  setProgress(null);
  setStatus("");
  return { types: types.length, rows: mdRows, skipped: mdSkipped };
}

function mdPackageXml(rows) {
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, new Set());
    byType.get(r.type).add(r.fullName);
  }
  const parts = [...byType.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([type, names]) =>
    `    <types>\n` +
    [...names].sort().map(n => `        <members>${escXml(n)}</members>`).join("\n") +
    `\n        <name>${escXml(type)}</name>\n    </types>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
    parts.join("\n") + `\n    <version>${MD_API_VERSION}</version>\n</Package>\n`;
}

// ---------- a minimal zip writer ----------
// Two files in one download, stored uncompressed. Nothing here needs a library: a zip is
// a local header per file, the file bytes, then a central directory pointing back at them.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : enc.encode(f.data);
    const crc = crc32(data);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...[...nameBytes]]);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = central.flat();
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralBytes.length), ...u32(offset), ...u16(0)];
  return new Blob([...chunks, new Uint8Array(centralBytes), new Uint8Array(end)], { type: "application/zip" });
}

// ---------- the button ----------
async function exportAllMetadata() {
  const btn = $("mdAllBtn");
  btn.disabled = true;
  try {
    const skipManaged = $("mdSkipManaged").checked;
    const res = await collectAllMetadata();
    const kept = skipManaged
      ? res.rows.filter(r => r.manageableState === "unpackaged" || !r.manageableState)
      : res.rows;
    if (!kept.length) throw new Error("The org returned no components. The Metadata API may be unavailable for this user.");

    const xml = mdPackageXml(kept);

    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Type", "Member", "Last modified", "Last modified by", "Created", "State", "Namespace", "File"],
      ...kept.sort((a, b) => a.type.localeCompare(b.type) || a.fullName.localeCompare(b.fullName))
        .map(r => [r.type, r.fullName, (r.lastModified || "").slice(0, 19).replace("T", " "),
                   r.lastModifiedBy, (r.createdDate || "").slice(0, 10), r.manageableState, r.namespace, r.fileName])],
      "Metadata inventory", 45);

    const counts = new Map();
    for (const r of kept) counts.set(r.type, (counts.get(r.type) || 0) + 1);
    sheetFromRows(wb, [["Type", "Components"],
      ...[...counts.entries()].sort((a, b) => b[1] - a[1])], "Type summary");

    sheetFromRows(wb, [["Property", "Value"],
      ["Org", hostOf(auth)], ["Metadata API version", MD_API_VERSION],
      ["Types the org supports", res.types], ["Types with components", counts.size],
      ["Components listed", kept.length],
      ["Managed components", skipManaged ? "excluded" : "included"],
      ["Type queries that failed", res.skipped.length], ["Produced", today()],
      ["Note", "Enumerated through the Metadata API, so this covers types REST cannot see. Deleted components are not listed."],
      ...res.skipped.map(s => [`Failed: ${s.types}`, s.reason])], "About");

    const xlsx = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }));
    const stamp = `${hostOf(auth)}-${today()}`;
    const blob = zipStore([
      { name: "package.xml", data: xml },
      { name: `metadata-inventory-${stamp}.xlsx`, data: xlsx },
    ]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `metadata-${stamp}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);

    $("mdResTitle").textContent = `${kept.length} components across ${counts.size} types`;
    $("mdResNote").textContent = `package.xml and the inventory workbook are in metadata-${stamp}.zip. ` +
      (skipManaged ? "Managed-package components were excluded. " : "Managed-package components are included. ") +
      `Deleted components cannot appear in a listing, so this is the org as it stands.` +
      (res.skipped.length ? ` ${res.skipped.length} type quer${res.skipped.length === 1 ? "y" : "ies"} failed; see the About sheet.` : "");
    $("mdResSummary").innerHTML =
      `<span class="fact">Types supported: <b>${res.types}</b></span>` +
      `<span class="fact">Types in use: <b>${counts.size}</b></span>` +
      `<span class="fact">Components: <b>${fmt(kept.length)}</b></span>` +
      (res.skipped.length ? `<span class="e">Failed queries: ${res.skipped.length}</span>` : "");
    $("mdResList").innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)
      .map(([t, n]) => `<tr><td>${escHtml(t)}</td><td>${fmt(n)}</td></tr>`).join("");
    flashBox("mdResult");
    setStatus(`Done, ${kept.length} components zipped with the manifest.`, "ok");
  } catch (err) {
    setProgress(null);
    setStatus(`Full metadata export failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- SOQL autocomplete ----------
// Everything here is driven by describes the tool already fetches elsewhere, so suggestions
// are the org's real fields rather than a static keyword list. One describe per object, cached.
const SOQL_KEYWORDS = ["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "LIKE", "IN", "NOT IN",
  "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "OFFSET", "ASC", "DESC", "NULLS LAST",
  "COUNT()", "COUNT(Id)", "TODAY", "YESTERDAY", "LAST_N_DAYS:30", "THIS_MONTH", "LAST_MONTH"];

const acDescribes = new Map();     // API name -> describe
let acObjectNames = null;          // {data: [...], tooling: [...]}
let acItems = [], acIndex = 0, acToken = null;

async function acObjects() {
  const tooling = $("soqlTooling").checked;
  acObjectNames = acObjectNames || {};
  const key = tooling ? "tooling" : "data";
  if (acObjectNames[key]) return acObjectNames[key];
  try {
    if (tooling) {
      const r = await api("/tooling/sobjects/");
      acObjectNames.tooling = (r.sobjects || []).map(s => ({ name: s.name, label: s.label || s.name }));
    } else {
      acObjectNames.data = (await loadObjectList()).map(s => ({ name: s.name, label: s.label || s.name }));
    }
  } catch (err) {
    console.warn("object list for autocomplete failed:", err);
    acObjectNames[key] = [];
  }
  return acObjectNames[key] || [];
}

async function acDescribe(name) {
  const tooling = $("soqlTooling").checked;
  const key = (tooling ? "t:" : "d:") + name.toLowerCase();
  if (acDescribes.has(key)) return acDescribes.get(key);
  try {
    const d = await api(`${tooling ? "/tooling" : ""}/sobjects/${name}/describe/`);
    acDescribes.set(key, d);
    return d;
  } catch (err) {
    acDescribes.set(key, null);          // remember the failure so it is not retried per keystroke
    return null;
  }
}

// The object in the FROM clause, which is what makes field suggestions possible at all.
function acFromObject(text) {
  const m = /\bfrom\s+([A-Za-z0-9_]+)/i.exec(text);
  return m ? m[1] : null;
}

// Which clause the caret sits in decides what to offer: object names after FROM,
// field names in every other position.
function acContext(text, caret) {
  const before = text.slice(0, caret);
  const lastFrom = before.toLowerCase().lastIndexOf("from");
  if (lastFrom >= 0) {
    const after = before.slice(lastFrom + 4);
    // still inside the FROM clause: no other clause keyword has appeared since
    if (!/\b(where|order|group|having|limit|offset|using)\b/i.test(after) && !/,/.test(after)) {
      return /^\s*[A-Za-z0-9_]*$/.test(after) ? "object" : "field";
    }
  }
  return "field";
}

// The partial word under the caret, kept with its dotted prefix so traversal works.
function acTokenAt(text, caret) {
  let i = caret;
  while (i > 0 && /[A-Za-z0-9_.]/.test(text[i - 1])) i--;
  return { start: i, end: caret, text: text.slice(i, caret) };
}

async function acSuggest(explicit) {
  const ta = $("soqlText");
  const caret = ta.selectionStart;
  const text = ta.value;
  acToken = acTokenAt(text, caret);
  const raw = acToken.text;
  const kind = acContext(text, caret);

  // nothing typed yet and the user did not ask: stay out of the way
  if (!raw && !explicit) return acHide();

  let items = [];
  if (kind === "object") {
    const objs = await acObjects();
    const t = raw.toLowerCase();
    items = objs.filter(o => !t || o.name.toLowerCase().startsWith(t) || o.label.toLowerCase().includes(t))
      .slice(0, 40).map(o => ({ insert: o.name, name: o.name, label: o.label, kind: "obj", type: "" }));
  } else {
    const from = acFromObject(text);
    if (!from) return acHide();
    const parts = raw.split(".");
    const partial = parts.pop().toLowerCase();

    // walk any relationship prefix: Account.Owner. resolves through two describes
    let objName = from;
    for (const hop of parts) {
      const d = await acDescribe(objName);
      if (!d) return acHide();
      const rel = (d.fields || []).find(f =>
        (f.relationshipName || "").toLowerCase() === hop.toLowerCase() && (f.referenceTo || []).length);
      if (!rel) return acHide();
      objName = rel.referenceTo[0];      // polymorphic lookups: the first target is the useful guess
    }

    const d = await acDescribe(objName);
    if (!d) return acHide();
    const prefix = parts.length ? parts.join(".") + "." : "";

    // "every field" is the request people actually have, and typing it out is the reason
    // they reach for Setup instead. Two ways: expanded names, which always works, and
    // FIELDS(ALL), which is shorter but the platform caps it at 200 rows.
    if (!parts.length && (!partial || "allfields*".includes(partial) || "fields".startsWith(partial))) {
      const queryable = (d.fields || []).filter(f => f.type !== "address" && f.type !== "location");
      if (queryable.length) {
        items.push({ insert: queryable.map(f => f.name).join(", "), name: "* all fields",
                     label: `expand to all ${queryable.length} field names`, type: "", kind: "all" });
        items.push({ insert: "FIELDS(ALL)", name: "FIELDS(ALL)",
                     label: "shorter, but the platform requires LIMIT 200", type: "", kind: "kw" });
        items.push({ insert: "FIELDS(STANDARD)", name: "FIELDS(STANDARD)",
                     label: "standard fields only, no row cap", type: "", kind: "kw" });
      }
    }

    for (const f of d.fields || []) {
      if (partial && !f.name.toLowerCase().startsWith(partial) && !String(f.label).toLowerCase().includes(partial)) continue;
      items.push({ insert: prefix + f.name, name: f.name, label: f.label, type: f.type, kind: "fld" });
      if ((f.referenceTo || []).length && f.relationshipName) {
        // offer the traversal too, so Owner. is one pick away from Owner.Name
        items.push({ insert: prefix + f.relationshipName + ".", name: f.relationshipName + ".",
                     label: `through to ${f.referenceTo[0]}`, type: "", kind: "rel" });
      }
    }
    if (!parts.length && partial) {
      for (const k of SOQL_KEYWORDS) {
        if (k.toLowerCase().startsWith(partial)) items.push({ insert: k, name: k, label: "keyword", type: "", kind: "kw" });
      }
    }
    items = items.slice(0, 60);
  }

  if (!items.length) return acHide();
  acItems = items;
  acIndex = 0;
  acRender();
  $("soqlAcHint").textContent = kind === "object"
    ? `(${items.length} objects match; Enter or Tab to accept, Escape to dismiss)`
    : `(fields of ${acFromObject(text)}; "* all fields" expands every one, and a name ending in a dot walks the relationship)`;
}

function acRender() {
  $("soqlAc").innerHTML = acItems.map((it, i) =>
    `<div class="row ${i === acIndex ? "on" : ""}" data-ac="${i}">` +
    `<span class="kind ${it.kind === "obj" ? "obj" : it.kind === "rel" ? "rel" : it.kind === "all" ? "all" : ""}">` +
    `${it.kind === "obj" ? "object" : it.kind === "rel" ? "rel" : it.kind === "kw" ? "soql" : it.kind === "all" ? "all" : "field"}</span>` +
    `<span class="nm">${escHtml(it.name)}</span>` +
    `<span class="lb">${escHtml(it.label || "")}</span>` +
    (it.type ? `<span class="ty">${escHtml(it.type)}</span>` : "") +
    `</div>`).join("");
  $("soqlAc").style.display = "block";
}

function acHide() {
  $("soqlAc").style.display = "none";
  $("soqlAcHint").textContent = "";
  acItems = [];
}

function acAccept(i) {
  const it = acItems[i ?? acIndex];
  if (!it || !acToken) return;
  const ta = $("soqlText");
  const before = ta.value.slice(0, acToken.start);
  const after = ta.value.slice(acToken.end);
  // a relationship ends in a dot, so the caret stays put and the next hop can be typed
  const needsSpace = it.kind !== "rel" && !after.startsWith(" ") && !after.startsWith(",");
  ta.value = before + it.insert + (needsSpace ? " " : "") + after;
  const pos = before.length + it.insert.length + (needsSpace ? 1 : 0);
  ta.setSelectionRange(pos, pos);
  ta.focus();
  acHide();
  if (it.kind === "rel") acSuggest(true);      // straight into the next level
}

function acMove(delta) {
  if (!acItems.length) return;
  acIndex = (acIndex + delta + acItems.length) % acItems.length;
  acRender();
  const on = $("soqlAc").querySelector(".row.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

function wireSoqlAutocomplete() {
  const ta = $("soqlText");
  let timer = null;

  ta.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => acSuggest(false), 130);      // one describe per pause, not per keystroke
  });

  ta.addEventListener("keydown", (e) => {
    const open = $("soqlAc").style.display === "block";
    if ((e.ctrlKey || e.metaKey) && e.code === "Space") { e.preventDefault(); return acSuggest(true); }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); acMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acMove(-1); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acAccept(); }
    else if (e.key === "Escape") { e.preventDefault(); acHide(); }
  });

  ta.addEventListener("blur", () => setTimeout(acHide, 150));   // let a click land first
  $("soqlAc").addEventListener("mousedown", (e) => {
    const row = e.target.closest("[data-ac]");
    if (row) { e.preventDefault(); acAccept(Number(row.dataset.ac)); }
  });
  // switching API changes both the object list and every describe
  $("soqlTooling").addEventListener("change", () => { acDescribes.clear(); acObjectNames = null; acHide(); });
}

// EntityDefinition refuses queryMore(), so the usual paging helper fails on it with a 400.
// Paging by name instead keeps every batch a single request: ask for a page, then ask for
// the names after the last one. Works no matter how many entities the org has, and unlike
// OFFSET it has no 2000-row ceiling.
async function entityDefQuery(fields, where = "", pageSize = 200) {
  const rows = [];
  let after = "";
  for (let page = 0; page < 60; page++) {
    const clauses = [where, after ? `QualifiedApiName > '${after}'` : ""].filter(Boolean);
    const soql = `SELECT ${fields} FROM EntityDefinition` +
      (clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "") +
      ` ORDER BY QualifiedApiName LIMIT ${pageSize}`;
    const batch = await toolingQuery(soql);
    rows.push(...batch);
    if (batch.length < pageSize) break;
    after = batch[batch.length - 1].QualifiedApiName;
    if (!after) break;
    setStatus(`Reading objects… ${rows.length}`, "busy");
  }
  return rows;
}

// ---------- sharing model ----------
// Object and field access is what the rest of the tool covers; this is the record layer.
// The baseline lives on EntityDefinition, the hierarchy on UserRole, and the rules can only
// be counted (their criteria need a Metadata retrieve, which this does not do).
const OWD_LABEL = {
  Private: "Private", Read: "Public Read Only", ReadWrite: "Public Read/Write",
  ReadWriteTransfer: "Public Read/Write/Transfer", FullAccess: "Public Full Access",
  ControlledByParent: "Controlled by Parent", ControlledByLeadOrContact: "Controlled by Lead or Contact",
  ControlledByCampaign: "Controlled by Campaign",
};
const owdText = (v) => v ? (OWD_LABEL[v] || v) : "";

// anything other than Private or parent-controlled is open to some degree
const owdIsOpen = (v) => !!v && !/^Private$|^ControlledBy/.test(v);

const SHARING_RULE_TYPES = ["SharingCriteriaRule", "SharingOwnerRule", "SharingTerritoryRule", "SharingGuestRule"];
// not rules that widen access: reasons Apex can cite, and the two rule types that narrow it
const SHARING_EXTRA_TYPES = ["SharingReason", "RestrictionRule", "ScopingRule"];

let shOwd = [], shRoles = [], shGroups = [], shFacts = null;
const owdCache = new Map();

async function collectSharing() {
  setStatus("Reading org-wide defaults…", "busy");
  setProgress(5, "Org-wide defaults");
  const ents = await entityDefQuery(
    "QualifiedApiName, Label, InternalSharingModel, ExternalSharingModel, IsCustomSetting",
    "IsQueryable = true");

  // rules can only be counted, and only if the Metadata API is reachable
  const ruleCounts = new Map();
  let rulesRead = false, ruleTotal = 0;
  if ($("shRules").checked) {
    setProgress(35, "Sharing rules");
    setStatus("Asking the Metadata API for sharing rules…", "busy");
    try {
      const chunks = [];
      for (let i = 0; i < SHARING_RULE_TYPES.length; i += 3) chunks.push(SHARING_RULE_TYPES.slice(i, i + 3));
      for (const chunk of chunks) {
        const rows = await mdListChunk(auth, chunk.map(type => ({ type })));
        for (const r of rows) {
          // a rule's fullName is Object.RuleName
          const obj = String(r.fullName).split(".")[0];
          ruleCounts.set(obj, (ruleCounts.get(obj) || 0) + 1);
          ruleTotal++;
        }
      }
      rulesRead = true;
    } catch (err) {
      console.warn("sharing rules unavailable:", err);
    }

    // custom sharing reasons, restriction rules and scoping rules travel with the same API
    shReasons = [];
    try {
      const rows = await mdListChunk(auth, SHARING_EXTRA_TYPES.map(type => ({ type })));
      for (const r of rows) {
        const parts = String(r.fullName).split(".");
        shReasons.push({
          kind: r.type === "SharingReason" ? "Apex sharing reason"
              : r.type === "RestrictionRule" ? "Restriction rule" : "Scoping rule",
          object: parts.length > 1 ? parts[0] : "",
          name: parts.length > 1 ? parts.slice(1).join(".") : r.fullName,
        });
      }
      shReasons.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.object).localeCompare(String(b.object)));
    } catch (err) { console.warn("sharing reasons unavailable:", err); }
  }

  setProgress(65, "Role hierarchy");
  setStatus("Reading the role hierarchy…", "busy");
  const roles = await stdQuery("SELECT Id, Name, DeveloperName, ParentRoleId FROM UserRole ORDER BY Name").catch(() => []);
  const roleUsers = new Map();
  for (const u of await stdQuery("SELECT UserRoleId FROM User WHERE IsActive = true AND UserRoleId != null").catch(() => [])) {
    roleUsers.set(u.UserRoleId, (roleUsers.get(u.UserRoleId) || 0) + 1);
  }

  setProgress(85, "Groups and queues");
  const groups = await stdQuery(
    "SELECT Id, Name, DeveloperName, Type FROM Group WHERE Type IN ('Regular','Queue') ORDER BY Type, Name").catch(() => []);
  const memberCounts = new Map();
  for (const m of await stdQuery("SELECT GroupId FROM GroupMember").catch(() => [])) {
    memberCounts.set(m.GroupId, (memberCounts.get(m.GroupId) || 0) + 1);
  }
  setProgress(null);
  setStatus("");

  shOwd = ents.filter(e => !e.IsCustomSetting).map(e => ({
    label: e.Label || e.QualifiedApiName, api: e.QualifiedApiName,
    internal: e.InternalSharingModel, external: e.ExternalSharingModel,
    rules: ruleCounts.get(e.QualifiedApiName) || 0,
  })).filter(o => o.internal || o.external);
  for (const o of shOwd) owdCache.set(o.api, o);

  // depth by walking up to a role with no parent, so the tree reads as an indented list
  const byId = new Map(roles.map(r => [r.Id, r]));
  const depthOf = (r) => {
    let d = 0, cur = r;
    while (cur?.ParentRoleId && byId.has(cur.ParentRoleId) && d < 20) { cur = byId.get(cur.ParentRoleId); d++; }
    return d;
  };
  shRoles = roles.map(r => ({ name: r.Name, api: r.DeveloperName, depth: depthOf(r),
                              users: roleUsers.get(r.Id) || 0, parent: r.ParentRoleId }))
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));

  shGroups = groups.map(g => ({ name: g.Name, api: g.DeveloperName,
    kind: g.Type === "Queue" ? "Queue" : "Public group", members: memberCounts.get(g.Id) || 0 }));

  shFacts = {
    objects: shOwd.length,
    open: shOwd.filter(o => owdIsOpen(o.internal)).length,
    externalOpen: shOwd.filter(o => owdIsOpen(o.external)).length,
    rulesRead, ruleTotal,
    roles: shRoles.length, maxDepth: shRoles.reduce((n, r) => Math.max(n, r.depth), 0),
    groups: shGroups.filter(g => g.kind === "Public group").length,
    queues: shGroups.filter(g => g.kind === "Queue").length,
  };
  return shFacts;
}

function renderSharing() {
  const f = shFacts;
  $("shResTitle").textContent = `${f.objects} objects, ${f.roles} roles`;
  $("shResNote").textContent =
    (f.rulesRead ? `${f.ruleTotal} sharing rules counted. ` : "Sharing rules could not be read, so the rule column is blank. ") +
    "Rule criteria are not shown: those need a metadata retrieve, which this does not do. " +
    "Grant-access-using-hierarchies is metadata-only and is not reported either.";
  $("shResSummary").innerHTML =
    `<span class="fact">Open to internal users: <b>${f.open}</b></span>` +
    `<span class="fact">Open to external users: <b>${f.externalOpen}</b></span>` +
    `<span class="fact">Roles: <b>${f.roles}</b></span>` +
    `<span class="fact">Hierarchy depth: <b>${f.maxDepth + 1}</b></span>` +
    `<span class="fact">Public groups: <b>${f.groups}</b></span>` +
    `<span class="fact">Queues: <b>${f.queues}</b></span>`;

  renderOwdList();

  $("shRoleTitle").textContent = `${shRoles.length} roles, ${shFacts.maxDepth + 1} level${shFacts.maxDepth ? "s" : ""} deep`;
  $("shRoleList").innerHTML = shRoles.map(r =>
    `<tr><td style="padding-left:${8 + r.depth * 18}px;">${r.depth ? "&#9492; " : ""}${escHtml(r.name)}</td>` +
    `<td>${escHtml(r.api || "")}</td><td>${r.depth + 1}</td>` +
    `<td class="${r.users ? "" : "accNone"}">${r.users || "none"}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:var(--faint);">No roles, so the hierarchy grants nothing.</td></tr>`;

  $("shGroupTitle").textContent = `${shFacts.groups} public group${shFacts.groups === 1 ? "" : "s"}, ${shFacts.queues} queue${shFacts.queues === 1 ? "" : "s"}`;
  renderReasons();
  renderShareObjectPicker();
  shRows = [];
  renderShareRows();
  $("shApexBox").style.display = "none";
  $("shGroupList").innerHTML = shGroups.map(g =>
    `<tr><td>${escHtml(g.name)}</td><td>${escHtml(g.api || "")}</td><td>${escHtml(g.kind)}</td>` +
    `<td class="${g.members ? "" : "accNone"}">${g.members || "empty"}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:var(--faint);">No public groups or queues.</td></tr>`;
  flashBox("shResult");
}

function renderOwdList() {
  const term = $("shFilter").value.trim().toLowerCase();
  const openOnly = $("shOpenOnly").checked;
  const rows = shOwd.filter(o =>
    (!term || o.label.toLowerCase().includes(term) || o.api.toLowerCase().includes(term)) &&
    (!openOnly || owdIsOpen(o.internal) || owdIsOpen(o.external)));
  $("shOwdTitle").textContent = `${rows.length} of ${shOwd.length} objects`;
  $("shOwdList").innerHTML = rows.slice(0, 600).map(o =>
    `<tr><td>${escHtml(o.label)}</td><td>${escHtml(o.api)}</td>` +
    `<td class="${owdIsOpen(o.internal) ? "accRead" : ""}">${escHtml(owdText(o.internal))}</td>` +
    `<td class="${owdIsOpen(o.external) ? "accNone" : ""}">${escHtml(owdText(o.external))}</td>` +
    `<td>${o.rules || ""}</td></tr>`).join("")
    || `<tr><td colspan="5" style="color:var(--faint);">Nothing matches.</td></tr>`;
}

async function sharingShow() {
  const btn = $("shShowBtn");
  btn.disabled = true;
  try { await collectSharing(); renderSharing(); }
  catch (err) { setProgress(null); setStatus(`Sharing model failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function sharingExport() {
  const btn = $("shExportBtn");
  btn.disabled = true;
  try {
    await collectSharing();
    renderSharing();
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Object", "API name", "Internal default", "External default", "Sharing rules"],
      ...shOwd.map(o => [o.label, o.api, owdText(o.internal), owdText(o.external), o.rules || 0])], "Org-wide defaults", 40);
    sheetFromRows(wb, [["Role", "API name", "Depth", "Active users"],
      ...shRoles.map(r => [r.name, r.api, r.depth + 1, r.users])], "Role hierarchy");
    sheetFromRows(wb, [["Name", "API name", "Kind", "Members"],
      ...shGroups.map(g => [g.name, g.api, g.kind, g.members])], "Groups and queues");
    if (shReasons.length) sheetFromRows(wb, [["Kind", "Object", "Name"],
      ...shReasons.map(r => [r.kind, r.object, r.name])], "Reasons and rules");
    if (shRows.length) sheetFromRows(wb, [["Object", "Granted by", "Rows"],
      ...shRows.map(r => [r.api, r.cause, r.count])], "Share rows");
    if (shApexHits.length) sheetFromRows(wb, [["Class", "Share object", "Line", "Code"],
      ...shApexHits.map(x => [x.cls, x.token, x.line, x.code])], "Apex sharing", 60);
    sheetFromRows(wb, [["Measure", "Value"],
      ["Objects with a sharing model", shFacts.objects],
      ["Open to internal users", shFacts.open],
      ["Open to external users", shFacts.externalOpen],
      ["Sharing rules counted", shFacts.rulesRead ? shFacts.ruleTotal : "not readable"],
      ["Roles", shFacts.roles], ["Hierarchy depth", shFacts.maxDepth + 1],
      ["Public groups", shFacts.groups], ["Queues", shFacts.queues],
      ["Org", hostOf(auth)], ["Produced", today()],
      ["Custom sharing reasons and rules", shReasons.length],
      ["Share rows counted", shRows.length ? shRows.reduce((n, r) => n + (typeof r.count === "number" ? r.count : 0), 0) : "not run"],
      ["Apex share references", shApexHits.length || "not run"],
      ["Not included", "Sharing rule criteria and grant-access-using-hierarchies are metadata-only. " +
        "Sharing sets, share groups and implicit sharing are not exposed by any API."]], "About");
    XLSX.writeFile(wb, `sharing-model-${hostOf(auth)}-${today()}.xlsx`);
    setStatus(`Done, ${shOwd.length} objects and ${shRoles.length} roles.`, "ok");
  } catch (err) { setProgress(null); setStatus(`Export failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

// the same fact, shown where you are already standing: one object's defaults in the browser
async function showObjectOwd(name) {
  const box = $("bOwdFacts");
  box.style.display = "none";
  try {
    let o = owdCache.get(name);
    if (!o) {
      const rows = await toolingQuery(
        "SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition " +
        `WHERE QualifiedApiName = '${name.replace(/'/g, "")}' LIMIT 1`);
      const r = rows[0];
      if (!r) return;
      o = { api: name, internal: r.InternalSharingModel, external: r.ExternalSharingModel, rules: 0 };
      owdCache.set(name, o);
    }
    if (!o.internal && !o.external) return;
    box.innerHTML =
      (o.internal ? `<span class="fact">Internal default: <b>${escHtml(owdText(o.internal))}</b></span>` : "") +
      (o.external ? `<span class="fact">External default: <b>${escHtml(owdText(o.external))}</b></span>` : "");
    box.style.display = "flex";
  } catch (err) { console.warn("owd lookup failed:", err); }
}

// ---------- how access is actually granted ----------
// The baseline says what Salesforce grants by default. These three say what is granting
// access in practice: the reasons Apex may cite, the rules that take access away again,
// and the real share rows counted by cause.
const ROW_CAUSE_LABEL = {
  Owner: "Record owner", Manual: "Manual share", Rule: "Sharing rule", Team: "Team member",
  Territory: "Territory", TerritoryManual: "Territory, manual", TerritoryRule: "Territory rule",
  ImplicitChild: "Implicit, from child", ImplicitParent: "Implicit, from parent",
  ImplicitPerson: "Implicit, person account", GuestRule: "Guest rule",
  ManagerGroup: "Manager group", ManagerSubordinatesGroup: "Manager subordinates",
};
const causeText = (c) => ROW_CAUSE_LABEL[c] || (c || "unknown");

// A share object is the parent's name with Share appended; a custom object swaps its suffix.
function shareObjectFor(api) {
  return /__c$/.test(api) ? api.replace(/__c$/, "__Share") : `${api}Share`;
}

const shShareSel = new Set();
let shReasons = [], shRows = [], shApexHits = [];

function renderShareObjectPicker() {
  const term = $("shShareSearch").value.trim().toLowerCase();
  // controlled-by-parent objects have no share object of their own, so they are left out
  const eligible = shOwd.filter(o => !/^ControlledBy/.test(o.internal || ""));
  const list = eligible.filter(o => !term || o.label.toLowerCase().includes(term) || o.api.toLowerCase().includes(term));
  $("shShareList").innerHTML = list.slice(0, 300).map(o =>
    `<label><input type="checkbox" data-shobj="${escHtml(o.api)}" ${shShareSel.has(o.api) ? "checked" : ""}>` +
    `${escHtml(o.label)}<span class="api">${escHtml(shareObjectFor(o.api))}</span></label>`).join("")
    || `<div style="padding:12px; color:var(--faint);">Nothing matches, or no object qualifies.</div>`;
  $("shShareCount").textContent = `${shShareSel.size} selected`;
}

function renderReasons() {
  $("shGrantTitle").textContent = shReasons.length
    ? `${shReasons.length} reason${shReasons.length === 1 ? "" : "s"} and rule${shReasons.length === 1 ? "" : "s"}`
    : "nothing extra found";
  $("shReasonList").innerHTML = shReasons.map(r =>
    `<tr><td>${escHtml(r.kind)}</td><td>${escHtml(r.object || "")}</td><td>${escHtml(r.name)}</td></tr>`).join("")
    || `<tr><td colspan="3" style="color:var(--faint);">No custom sharing reasons, restriction rules or scoping rules, or the Metadata API was unavailable.</td></tr>`;
}

// One aggregate per object: cheap for Salesforce, since it counts server-side.
async function countShareRows() {
  const btn = $("shRowsBtn");
  btn.disabled = true;
  try {
    const objs = [...shShareSel];
    if (!objs.length) throw new Error("Tick at least one object.");
    if (objs.length > 10) throw new Error("Ten objects at a time; each one is a separate aggregate.");
    shRows = [];
    for (let i = 0; i < objs.length; i++) {
      const api = objs[i], shareObj = shareObjectFor(api);
      setProgress((i / objs.length) * 100, `Counting ${shareObj}`);
      setStatus(`Counting ${shareObj}…`, "busy");
      try {
        const rows = await stdQuery(`SELECT RowCause, COUNT(Id) c FROM ${shareObj} GROUP BY RowCause ORDER BY COUNT(Id) DESC`);
        if (!rows.length) shRows.push({ api, cause: "(no share rows)", count: 0 });
        for (const r of rows) shRows.push({ api, cause: causeText(r.RowCause), raw: r.RowCause, count: r.c });
      } catch (err) {
        // Public Read/Write objects have no share table, and some objects refuse the aggregate
        shRows.push({ api, cause: `(not available: ${err.message})`, count: "" });
      }
    }
    setProgress(null);
    setStatus("");
    renderShareRows();
  } catch (err) {
    setProgress(null);
    setStatus(`Share counts failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

function renderShareRows() {
  const total = shRows.reduce((n, r) => n + (typeof r.count === "number" ? r.count : 0), 0);
  $("shRowsList").innerHTML = shRows.map(r => {
    // a custom reason ends in __c, and that is the fingerprint of Apex managed sharing
    const apexy = /__c$/.test(r.raw || "");
    return `<tr><td>${escHtml(r.api)}</td>` +
      `<td class="${apexy ? "accRead" : ""}">${escHtml(r.cause)}${apexy ? " (Apex reason)" : ""}</td>` +
      `<td>${typeof r.count === "number" ? fmt(r.count) : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="3" style="color:var(--faint);">Nothing counted yet.</td></tr>`;
  if (shRows.length) setStatus(`${fmt(total)} share rows across ${new Set(shRows.map(r => r.api)).size} objects.`, "ok");
}

// Static evidence, to pair with the row counts: which classes write to a share object.
const APEX_SHARE_RE = /(\b\w+__Share\b|\b(?:Account|Contact|Case|Opportunity|Lead|Campaign|Contract|Asset|Order|Product2|Quote|User)Share\b|\bRowCause\b)/;

async function findApexSharing() {
  const btn = $("shApexBtn");
  btn.disabled = true;
  try {
    setStatus("Reading Apex source…", "busy");
    setProgress(10, "Apex classes");
    const classes = await stdQuery(
      "SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name");
    setProgress(70, "Scanning");
    shApexHits = [];
    for (const c of classes) {
      if (typeof c.Body !== "string" || c.Body.startsWith("(hidden)")) continue;
      const lines = c.Body.split(/\r?\n/);
      lines.forEach((line, i) => {
        const m = APEX_SHARE_RE.exec(line);
        if (!m) return;
        shApexHits.push({ cls: c.Name, token: m[1], line: i + 1, code: line.trim().slice(0, 200) });
      });
    }
    setProgress(null);
    setStatus("");
    const classCount = new Set(shApexHits.map(x => x.cls)).size;
    $("shApexTitle").textContent = `${shApexHits.length} reference${shApexHits.length === 1 ? "" : "s"} in ${classCount} class${classCount === 1 ? "" : "es"}`;
    $("shApexNote").textContent = shApexHits.length
      ? "Lines that mention a share object or RowCause. A mention is not proof of a share being inserted, so read the line before concluding."
      : "No Apex touches a share object, so nothing here is granting access through code.";
    $("shApexList").innerHTML = shApexHits.slice(0, 300).map(x =>
      `<tr><td>${escHtml(x.cls)}</td><td>${escHtml(x.token)}</td><td>${x.line}</td><td><code>${escHtml(x.code)}</code></td></tr>`).join("")
      || `<tr><td colspan="4" style="color:var(--faint);">Nothing found.</td></tr>`;
    $("shApexBox").style.display = "block";
    flashBox("shApexBox");
  } catch (err) {
    setProgress(null);
    setStatus(`Apex scan failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- documentation pack ----------
// One printable document assembled from the same reads the individual panels use, so a
// number here always matches the number on its own panel. Everything is inlined: the file
// opens with no network and no assets beside it.
const docSel = new Set();
let docObjects = null;

async function initDoc() {
  chrome.storage.local.get(["docBrand"], (r) => {
    const b = r?.docBrand || {};
    for (const k of ["docTitle", "docClient", "docAuthor", "docNote"]) if (b[k]) $(k).value = b[k];
  });
  if (docObjects) return;
  try {
    docObjects = await loadObjectList();
    renderDocList();
  } catch (err) { setStatus(`Could not load objects: ${err.message}`, "err"); }
}

function saveDocBrand() {
  const b = {};
  for (const k of ["docTitle", "docClient", "docAuthor", "docNote"]) b[k] = $(k).value.trim();
  chrome.storage.local.set({ docBrand: b });
}

function renderDocList() {
  const term = $("docSearch").value.trim().toLowerCase();
  const list = (docObjects || []).filter(o =>
    !term || o.name.toLowerCase().includes(term) || String(o.label).toLowerCase().includes(term));
  $("docList").innerHTML = list.slice(0, 400).map(o =>
    `<label><input type="checkbox" data-docobj="${escHtml(o.name)}" ${docSel.has(o.name) ? "checked" : ""}>` +
    `${escHtml(o.label)}<span class="api">${escHtml(o.name)}</span></label>`).join("")
    || `<div style="padding:12px; color:var(--faint);">Nothing matches that.</div>`;
  $("docCount").textContent = `${docSel.size} selected`;
}

// ---- section builders: each returns HTML, or a stated reason for being empty ----

function docTable(head, rows, note) {
  if (!rows.length) return `<p class="empty">${escHtml(note || "Nothing found.")}</p>`;
  return `<table><thead><tr>${head.map(x => `<th>${escHtml(x)}</th>`).join("")}</tr></thead><tbody>` +
    rows.map(r => `<tr>${r.map(c => `<td>${escHtml(String(c ?? ""))}</td>`).join("")}</tr>`).join("") +
    `</tbody></table>`;
}

async function docOverview() {
  const [limits, orgRows, users] = await Promise.all([
    api("/limits/").catch(() => ({})),
    stdQuery("SELECT Name, OrganizationType, IsSandbox, InstanceName FROM Organization").catch(() => []),
    api(`/query/?q=${encodeURIComponent("SELECT COUNT() FROM User WHERE IsActive = true AND UserType = 'Standard'")}`).catch(() => null),
  ]);
  const org = orgRows[0] || {};
  const facts = [
    ["Org name", org.Name || "(unavailable)"],
    ["Edition", org.OrganizationType || ""],
    ["Type", org.IsSandbox ? "Sandbox" : "Production"],
    ["Instance", org.InstanceName || ""],
    ["Active standard users", users?.totalSize != null ? fmt(users.totalSize) : ""],
    ["API host", hostOf(auth)],
  ].filter(r => r[1] !== "");

  const inv = await fetchInventory().catch(() => []);

  // only the limits worth a reader's attention: the ones actually being consumed
  const pressure = Object.entries(limits || {})
    .filter(([, o]) => o && typeof o.Max === "number" && o.Max > 0)
    .map(([k, o]) => {
      const used = o.Max - (o.Remaining ?? 0);
      return [k.replace(/([a-z])([A-Z])/g, "$1 $2"), fmt(used), fmt(o.Max), Math.round(used / o.Max * 100) + "%"];
    })
    .filter(r => parseInt(r[3]) >= 1)
    .sort((a, b) => parseInt(b[3]) - parseInt(a[3]))
    .slice(0, 12);

  return `<h2>Org overview</h2>` +
    docTable(["Property", "Value"], facts) +
    `<h3>Inventory</h3>` +
    docTable(["Component", "Count"], inv.map(i => [i.label, fmt(i.value)]),
      "Inventory counts were unavailable for this user.") +
    `<h3>Limits in use</h3>` +
    docTable(["Limit", "Used", "Maximum", "Used %"], pressure, "No limit is currently being consumed.") +
    `<p class="foot">Limits are a snapshot taken when this document was produced.</p>`;
}

function docErd() {
  if (!erdModel) {
    return `<h2>Schema diagram</h2><p class="empty">No diagram was drawn, so this section is empty. ` +
      `Draw and arrange one on the Schema diagram panel, then build the document again.</p>`;
  }
  const svg = erdStandaloneSvg();
  const objs = erdModel.nodes.map(n => n.id).sort().join(", ");
  return `<h2>Schema diagram</h2><div class="figure">${svg}</div>` +
    `<p class="caption">${erdModel.nodes.length} objects, ${erdModel.edges.length} relationships. ` +
    `Solid lines are master-detail, dashed are lookups, and a crow's foot marks the many end. ` +
    `Objects shown: ${escHtml(objs)}.</p>`;
}

async function docCatalogue(names) {
  if (!names.length) return `<h2>Object catalogue</h2><p class="empty">No objects were ticked, so this section is empty.</p>`;
  // describeAllFor returns a map keyed by API name, so the catalogue walks the ticked
  // order rather than the map, keeping the document in the order shown on screen
  const describes = await describeAllFor(auth, names, "catalogue");
  let out = `<h2>Object catalogue</h2>`;
  for (const name of names) {
    const d = describes[name];
    if (!d) { out += `<h3>${escHtml(name)}</h3><p class="empty">This object could not be described for this user.</p>`; continue; }
    const rows = (d.fields || []).map(f => [
      f.label, f.name, f.type + (f.length ? `(${f.length})` : ""),
      f.custom ? "Custom" : "Standard",
      [f.nillable === false && f.createable ? "required" : "", f.unique ? "unique" : "",
       f.externalId ? "external id" : "", f.calculated ? "formula" : ""].filter(Boolean).join(", "),
      (f.referenceTo || []).join(", "),
    ]);
    const custom = (d.fields || []).filter(f => f.custom).length;
    const rts = (d.recordTypeInfos || []).filter(r => !r.master).length;
    out += `<h3>${escHtml(d.label || d.name)} <span class="api">${escHtml(d.name)}</span></h3>` +
      `<p class="meta">${(d.fields || []).length} fields, ${custom} of them custom &middot; ` +
      `${d.custom ? "custom object" : "standard object"} &middot; record types: ${rts}</p>` +
      docTable(["Label", "API name", "Type", "Origin", "Flags", "Looks up to"], rows);
  }
  return out;
}

async function docAutomation(names) {
  const rows = await collectAutomationRows(new Set(names.map(n => n.toLowerCase()))).catch(() => []);
  const scope = names.length ? `on ${names.length} object${names.length === 1 ? "" : "s"}` : "across the org";
  return `<h2>Automation</h2><p class="meta">Everything that runs ${scope}: Apex triggers, ` +
    `record-triggered flows, process builders and the older workflow rules.</p>` +
    docTable(["Object", "Type", "Name", "Active", "Trigger", "Kind"], rows,
      "No automation was found for these objects.");
}

async function docPermissions() {
  const [profiles, sets] = await Promise.all([
    stdQuery("SELECT Name, UserType FROM Profile ORDER BY Name").catch(() => []),
    stdQuery("SELECT Label, Name FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label").catch(() => []),
  ]);
  let posture = "";
  try {
    await collectSecurity();
    posture = `<h3>Elevated access</h3>` +
      docTable(["Permission", "People holding it"], secFacts.byPerm.map(([label, n]) => [label, n])) +
      docTable(["User", "Profile", "Permission", "Granted via"],
        secElev.slice(0, 200).map(r => [r.user, r.profile, r.perm, r.via])) +
      (secElev.length > 200 ? `<p class="foot">First 200 of ${secElev.length} grants shown.</p>` : "") +
      `<h3>Unused and stale containers</h3>` +
      docTable(["Type", "Name", "Note"], secUnused.map(u => [u.type, u.name, u.note]),
        "Every profile and permission set is in use.");
  } catch (err) {
    posture = `<p class="empty">The elevated-access review could not run for this user (${escHtml(err.message)}).</p>`;
  }
  return `<h2>Permissions and security</h2>` +
    `<h3>Profiles (${profiles.length})</h3>` +
    docTable(["Profile", "User type"], profiles.map(p => [p.Name, p.UserType || ""])) +
    `<h3>Permission sets (${sets.length})</h3>` +
    docTable(["Permission set", "API name"], sets.map(s => [s.Label || s.Name, s.Name])) +
    posture;
}

// ---- assembly ----

function docShell(meta, sections) {
  const style = `
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 11pt/1.5 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #10182b; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 28px 30px 60px; }
    .cover { min-height: 80vh; display: flex; flex-direction: column; justify-content: center;
             border-bottom: 3px solid #0176d3; }
    .cover .eyebrow { font-size: 10.5pt; letter-spacing: .14em; text-transform: uppercase;
                      color: #0176d3; font-weight: 700; }
    .cover h1 { font-size: 30pt; line-height: 1.15; margin: 10px 0 6px; }
    .cover .client { font-size: 16pt; color: #33415c; }
    .cover dl { margin: 26px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; font-size: 10.5pt; }
    .cover dt { color: #5b6b83; }
    .cover dd { margin: 0; font-weight: 600; }
    h2 { font-size: 17pt; margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #e5eaf1; page-break-after: avoid; }
    h3 { font-size: 12.5pt; margin: 22px 0 6px; page-break-after: avoid; }
    h3 .api { font-family: ui-monospace, Consolas, monospace; font-size: 10pt; color: #5b6b83; font-weight: 500; }
    p.meta { color: #5b6b83; font-size: 10pt; margin: 0 0 10px; }
    p.empty { color: #7b8ba3; font-style: italic; }
    p.caption { color: #5b6b83; font-size: 9.5pt; margin-top: 8px; }
    p.foot { color: #7b8ba3; font-size: 9pt; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 9.5pt; }
    th { text-align: left; background: #f2f7fc; color: #0b3d68; font-size: 8.5pt; letter-spacing: .05em;
         text-transform: uppercase; padding: 6px 8px; border-bottom: 1.5px solid #d7e5f2; }
    td { padding: 5px 8px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
    tr { page-break-inside: avoid; }
    .figure { border: 1px solid #e5eaf1; border-radius: 8px; padding: 10px; overflow: hidden; }
    .figure svg { width: 100%; height: auto; }
    .toc { margin: 30px 0 0; padding-left: 18px; font-size: 10.5pt; }
    .toc li { padding: 4px 0; }
    .section { page-break-before: always; }
    @media print { .wrap { padding: 0; } }
  `;
  const dl = [
    ["Org", meta.org], ["Environment", meta.env], ["Prepared by", meta.author],
    ["Produced", meta.date], ["Tool", `Org Lens ${APP_VERSION}`],
  ].filter(r => r[1]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(meta.title)}</title>` +
    `<style>${style}</style></head><body><div class="wrap">` +
    `<section class="cover"><div class="eyebrow">Salesforce documentation</div>` +
    `<h1>${escHtml(meta.title)}</h1>` +
    (meta.client ? `<div class="client">${escHtml(meta.client)}</div>` : "") +
    (meta.note ? `<p class="meta" style="margin-top:14px;">${escHtml(meta.note)}</p>` : "") +
    `<dl>${dl.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join("")}</dl>` +
    `<ol class="toc">${meta.contents.map(c => `<li>${escHtml(c)}</li>`).join("")}</ol>` +
    `</section>` +
    sections.map(s => `<section class="section">${s}</section>`).join("") +
    `</div></body></html>`;
}

async function buildDocPack(forWord) {
  const names = [...docSel];
  if (names.length > 25) throw new Error("Tick 25 objects or fewer for the catalogue.");
  saveDocBrand();

  const wants = {
    overview: $("docSecOverview").checked, erd: $("docSecErd").checked,
    catalogue: $("docSecCatalogue").checked, auto: $("docSecAuto").checked, perms: $("docSecPerms").checked,
  };
  if (!Object.values(wants).some(Boolean)) throw new Error("Tick at least one section.");

  const orgRows = await stdQuery("SELECT Name, IsSandbox FROM Organization").catch(() => []);
  const meta = {
    title: $("docTitle").value.trim() || "Salesforce org documentation",
    client: $("docClient").value.trim(),
    author: $("docAuthor").value.trim(),
    note: $("docNote").value.trim(),
    org: orgRows[0]?.Name || hostOf(auth),
    env: orgRows[0]?.IsSandbox ? "Sandbox" : "Production",
    date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    contents: [],
  };

  const sections = [];
  const steps = Object.values(wants).filter(Boolean).length;
  let done = 0;
  const step = (label) => { setProgress((done / steps) * 100, label); setStatus(label + "\u2026", "busy"); };

  if (wants.overview) { step("Org overview"); sections.push(await docOverview()); meta.contents.push("Org overview"); done++; }
  if (wants.erd) { step("Schema diagram"); sections.push(docErd()); meta.contents.push("Schema diagram"); done++; }
  if (wants.catalogue) { step("Object catalogue"); sections.push(await docCatalogue(names)); meta.contents.push("Object catalogue"); done++; }
  if (wants.auto) { step("Automation"); sections.push(await docAutomation(names)); meta.contents.push("Automation"); done++; }
  if (wants.perms) { step("Permissions and security"); sections.push(await docPermissions()); meta.contents.push("Permissions and security"); done++; }
  setProgress(null);

  const html = docShell(meta, sections);
  const slug = (meta.client || meta.org || "org").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const name = `${slug || "org"}-documentation-${today()}.${forWord ? "doc" : "html"}`;
  // Word opens plain HTML happily; the .doc extension is what makes it the default app
  downloadBlob(name, html, forWord ? "application/msword" : "text/html");

  $("docResTitle").textContent = meta.title;
  $("docResNote").textContent = `${sections.length} section${sections.length === 1 ? "" : "s"} written to ${name}. ` +
    (forWord ? "Open it in Word, then save as .docx if you want to edit it further."
             : "Open it in a browser and print to PDF for a fixed copy.");
  $("docResSummary").innerHTML =
    meta.contents.map(c => `<span class="fact">${escHtml(c)}</span>`).join("") +
    `<span class="fact">Objects catalogued: <b>${names.length}</b></span>` +
    (erdModel && wants.erd ? `<span class="fact">Diagram: <b>${erdModel.nodes.length} objects</b></span>` : "");
  flashBox("docResult");
  setStatus(`Document ready: ${name}`, "ok");
  return { name, html, meta };
}

async function docBuild(forWord) {
  const btn = forWord ? $("docWordBtn") : $("docBuildBtn");
  btn.disabled = true;
  try { await buildDocPack(forWord); }
  catch (err) { setProgress(null); setStatus(`Document failed: ${err.message}`, "err"); }
  finally { btn.disabled = false; }
}

// ---------- automation panel object picker ----------
const autoSel = new Set();
let autoInited = false;

async function initAuto() {
  if (autoInited) return;
  try {
    setStatus("Loading object list…", "busy");
    await loadObjectList();
    autoInited = true;
    setStatus("");
    renderAutoList();
  } catch (err) { setStatus("Could not load objects: " + err.message, "err"); }
}

function renderAutoList() {
  const q = $("autoSearch").value.trim().toLowerCase();
  const list = (allObjects || [])
    .filter(s => !q || s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .slice(0, 300);
  $("autoList").innerHTML = list.map(s =>
    '<label><input type="checkbox" data-aobj="' + escHtml(s.name) + '"' + (autoSel.has(s.name) ? " checked" : "") + '>' +
    hl(s.label, q) + '<span class="api">' + hl(s.name, q) + '</span></label>').join("")
    || '<div style="padding:10px; font-size:13px; color:var(--faint);">No objects match.</div>';
  $("autoCount").textContent = autoSel.size ? autoSel.size + " selected" : "0 selected (whole org)";
}

const autoFilterSet = () => new Set([...autoSel].map(s => s.toLowerCase()));

async function showAuto() {
  const btn = $("autoShowBtn");
  btn.disabled = true;
  try {
    const rows = await collectAutomationRows(autoFilterSet());
    const body = rows.slice(1);
    $("autoResTitle").textContent = autoSel.size ? [...autoSel].join(", ") : "whole org";
    $("autoResNote").textContent = body.length
      ? "Everything that fires on record changes, newest query first. Export to Excel for the full filterable sheet."
      : "No automation found for this selection.";
    const byType = {};
    for (const r of body) byType[r[1]] = (byType[r[1]] || 0) + 1;
    $("autoResSummary").innerHTML = Object.entries(byType).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => '<span class="r">' + n + " " + escHtml(t) + (n > 1 ? "s" : "") + "</span>").join("")
      + '<span class="n">' + body.filter(r => r[3] === "No").length + " inactive</span>";
    $("autoResList").innerHTML = body.slice(0, 400).map(r =>
      "<tr><td>" + escHtml(r[0]) + "</td><td>" + escHtml(r[1]) + "</td><td>" + escHtml(r[2]) + "</td>" +
      '<td class="' + (r[3] === "Yes" ? "accEdit" : r[3] === "No" ? "accNone" : "") + '">' + escHtml(r[3]) + "</td>" +
      "<td>" + escHtml(r[4]) + "</td></tr>").join("")
      || '<tr><td colspan="5" style="color:var(--faint);">Nothing to show.</td></tr>';
    if (body.length > 400) $("autoResNote").textContent += " Showing the first 400 of " + body.length + " rows.";
    const box = $("autoResult");
    box.style.display = "block";
    box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
    box.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus("");
  } catch (err) {
    setStatus("Could not load automation: " + err.message, "err");
  } finally { btn.disabled = false; }
}

// ---------- Where is it used (dependencies) ----------


// The Dependency API keys custom fields by NAME, so the same field name on two objects
// would collide. Resolving the field's id first makes the lookup exact.
async function fieldDependencyId(objName, fieldName) {
  try {
    const fd = await toolingQuery(
      `SELECT DurableId FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objName}' ` +
      `AND QualifiedApiName = '${fieldName.replace(/'/g, "")}' LIMIT 1`);
    const durable = fd[0]?.DurableId;           // e.g. "Account.00N5j000001abcd"
    const id = durable && durable.includes(".") ? durable.split(".").pop() : durable;
    return /^[a-zA-Z0-9]{15,18}$/.test(id || "") ? id : null;
  } catch (e) { console.warn("field id lookup failed:", e); return null; }
}

// Filtering the Dependency API by RefMetadataComponentName is rejected outright in some
// orgs ("RefMetadataComponentName is unknown"), and it is ambiguous anyway: two objects can
// hold a field of the same name. So the component's own id is resolved first and the lookup
// filters on RefMetadataComponentId, which every org accepts. One query per type, cached.
const DEP_ID_LOOKUPS = {
  ApexClass: (n) => ["std", `SELECT Id FROM ApexClass WHERE Name = '${n}' LIMIT 1`],
  ApexPage: (n) => ["std", `SELECT Id FROM ApexPage WHERE Name = '${n}' LIMIT 1`],
  ApexComponent: (n) => ["std", `SELECT Id FROM ApexComponent WHERE Name = '${n}' LIMIT 1`],
  StaticResource: (n) => ["std", `SELECT Id FROM StaticResource WHERE Name = '${n}' LIMIT 1`],
  PermissionSet: (n) => ["std", `SELECT Id FROM PermissionSet WHERE Name = '${n}' LIMIT 1`],
  CustomPermission: (n) => ["std", `SELECT Id FROM CustomPermission WHERE DeveloperName = '${n}' LIMIT 1`],
  LightningComponentBundle: (n) => ["tool", `SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${n}' LIMIT 1`],
  AuraDefinitionBundle: (n) => ["tool", `SELECT Id FROM AuraDefinitionBundle WHERE DeveloperName = '${n}' LIMIT 1`],
  GlobalValueSet: (n) => ["tool", `SELECT Id FROM GlobalValueSet WHERE DeveloperName = '${n}' LIMIT 1`],
  CustomLabel: (n) => ["tool", `SELECT Id FROM ExternalString WHERE Name = '${n}' LIMIT 1`],
  Flow: (n) => ["tool", `SELECT Id FROM FlowDefinition WHERE DeveloperName = '${n}' LIMIT 1`],
  // a custom object's dependency key is its EntityDefinition durable id
  CustomObject: (n) => ["tool", `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${n}__c' LIMIT 1`],
};

async function dependencyComponentId(type, name, objName) {
  const clean = String(name).replace(/'/g, "");
  if (type === "CustomField" && objName) return await fieldDependencyId(objName, clean);

  if (type === "RecordType" && clean.includes(".")) {
    const [sobj, dev] = clean.split(".");
    const r = await stdQuery(
      `SELECT Id FROM RecordType WHERE SobjectType = '${sobj}' AND DeveloperName = '${dev}' LIMIT 1`).catch(() => []);
    return r[0]?.Id || null;
  }
  if (type === "QuickAction") {
    const dev = clean.includes(".") ? clean.split(".").pop() : clean;
    const r = await toolingQuery(
      `SELECT Id FROM QuickActionDefinition WHERE DeveloperName = '${dev}' LIMIT 1`).catch(() => []);
    return r[0]?.Id || null;
  }

  const spec = DEP_ID_LOOKUPS[type];
  if (!spec) return null;
  const [api, soql] = spec(clean);
  const rows = await (api === "std" ? stdQuery(soql) : toolingQuery(soql)).catch(() => []);
  const row = rows[0] || {};
  const raw = row.Id || row.DurableId || null;
  if (!raw) return null;
  // FieldDefinition-style durable ids arrive as "Object.Id"
  return String(raw).includes(".") ? String(raw).split(".").pop() : String(raw);
}

// The Dependency API records a component only where the platform can see a real reference.
// A component pulled into Visualforce through lightning:out, or named inside a flow's
// definition, is a STRING, so it is invisible there: an LWC used by a VF page and a screen
// flow can come back with nothing but the Aura wrapper. Those usages are found by reading
// the source instead, and reported as such rather than mixed in silently.
function componentTokens(bundle) {
  const kebab = String(bundle).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return [
    `c:${bundle}`,      // Aura markup, Visualforce lightning:out, a flow's extensionName
    `c-${kebab}`,       // an LWC template tag
    `c/${bundle}`,      // an import in another LWC's JavaScript
    `"${bundle}"`, `'${bundle}'`,   // a bare name, as a quick action or a tab refers to it
  ];
}

async function componentSourceUsages(bundle) {
  const tokens = componentTokens(bundle);
  const hit = (text) => typeof text === "string" && tokens.some(t => text.includes(t));
  const found = [];
  const sources = [
    ["Visualforce Page", "SELECT Name, Markup FROM ApexPage WHERE NamespacePrefix = null", "Markup", r => r.Name],
    ["Visualforce Component", "SELECT Name, Markup FROM ApexComponent WHERE NamespacePrefix = null", "Markup", r => r.Name],
    ["Apex Class", "SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null", "Body", r => r.Name],
    ["Aura Bundle", "SELECT Source, AuraDefinitionBundle.DeveloperName FROM AuraDefinition " +
      "WHERE AuraDefinitionBundle.NamespacePrefix = null", "Source", r => r.AuraDefinitionBundle?.DeveloperName],
    ["LWC Bundle", "SELECT Source, LightningComponentBundle.DeveloperName FROM LightningComponentResource " +
      "WHERE LightningComponentBundle.NamespacePrefix = null", "Source", r => r.LightningComponentBundle?.DeveloperName],
  ];
  for (const [label, soql, field, nameOf] of sources) {
    setStatus(`Reading ${label} source…`, "busy");
    try {
      const runner = /FROM Apex(Page|Component|Class)/.test(soql) ? stdQuery : toolingQuery;
      const seen = new Set();
      for (const r of await runner(soql)) {
        const who = nameOf(r);
        if (!who || who === bundle || seen.has(who)) continue;   // never itself
        if (hit(r[field])) { seen.add(who); found.push({ type: label, name: who }); }
      }
    } catch (err) { console.warn(`source scan of ${label} failed:`, err); }
  }

  // Flows keep their definition as metadata rather than queryable text, so this reads the
  // active version of each and looks inside. Capped, because each one is a sizeable payload.
  setStatus("Reading flow definitions…", "busy");
  let flowsChecked = 0, flowsCapped = false;
  try {
    const defs = await toolingQuery("SELECT Id, MasterLabel FROM Flow WHERE Status = 'Active' ORDER BY MasterLabel");
    const CAP = 120;
    flowsCapped = defs.length > CAP;
    for (const d of defs.slice(0, CAP)) {
      flowsChecked++;
      try {
        const full = await api(`/tooling/sobjects/Flow/${d.Id}`);
        if (hit(JSON.stringify(full.Metadata || {}))) found.push({ type: "Flow", name: d.MasterLabel || d.Id });
      } catch { /* a flow that will not open is skipped rather than failing the run */ }
      if (flowsChecked % 10 === 0) setProgress((flowsChecked / Math.min(defs.length, CAP)) * 100, "Reading flows");
    }
  } catch (err) { console.warn("flow scan unavailable:", err); }
  setProgress(null);
  setStatus("");
  return { found, flowsChecked, flowsCapped };
}

async function dependencyUsages({ type, name, objName }) {
  const byId = await dependencyComponentId(type, name, objName);
  if (byId) {
    const recs = await toolingQuery(
      `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency ` +
      `WHERE RefMetadataComponentId = '${byId}'`);
    // a component can be referenced by name in markup or in a flow, which the API cannot see
    if (type === "LightningComponentBundle" || type === "AuraDefinitionBundle") {
      const extra = await componentSourceUsages(name);
      const known = new Set(recs.map(r => `${r.MetadataComponentType}|${r.MetadataComponentName}`));
      for (const f of extra.found) {
        if (known.has(`${f.type}|${f.name}`)) continue;
        recs.push({ MetadataComponentName: f.name, MetadataComponentType: f.type, fromSource: true });
      }
      return { recs, exact: true, scanned: extra };
    }
    return { recs, exact: true };
  }
  // no id resolved: the name filter is the only option left, and it is not accepted
  // everywhere, so the failure is reported in the terms the panel can explain
  try {
    const recs = await toolingQuery(
      `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency ` +
      `WHERE RefMetadataComponentType = '${type}' AND RefMetadataComponentName = '${String(name).replace(/'/g, "")}'`);
    return { recs, exact: type !== "CustomField" };
  } catch (e) {
    throw new Error(`Could not resolve ${name} to an id, and this org rejects lookups by name (${e.message}).`);
  }
}

// ---------- dependency panel: pick the component from the org ----------
let depNames = [];            // [{value, label}]
let depsInited = false;

const DEP_SOURCES = {
  CustomObject: async () => (await loadObjectList()).filter(s => s.custom)
    .map(s => ({ value: s.name.replace(/__c$/, ""), label: `${s.label} (${s.name})` })),
  ApexClass: async () => (await stdQuery("SELECT Name FROM ApexClass ORDER BY Name")).map(r => ({ value: r.Name, label: r.Name })),
  ApexPage: async () => (await stdQuery("SELECT Name, MasterLabel FROM ApexPage ORDER BY Name"))
    .map(r => ({ value: r.Name, label: r.MasterLabel && r.MasterLabel !== r.Name ? `${r.MasterLabel} (${r.Name})` : r.Name })),
  ApexComponent: async () => (await stdQuery("SELECT Name FROM ApexComponent ORDER BY Name")).map(r => ({ value: r.Name, label: r.Name })),
  LightningComponentBundle: async () => (await toolingQuery("SELECT DeveloperName FROM LightningComponentBundle ORDER BY DeveloperName"))
    .map(r => ({ value: r.DeveloperName, label: r.DeveloperName })),
  AuraDefinitionBundle: async () => (await toolingQuery("SELECT DeveloperName FROM AuraDefinitionBundle ORDER BY DeveloperName"))
    .map(r => ({ value: r.DeveloperName, label: r.DeveloperName })),
  StaticResource: async () => (await stdQuery("SELECT Name FROM StaticResource ORDER BY Name")).map(r => ({ value: r.Name, label: r.Name })),
  PermissionSet: async () => (await stdQuery("SELECT Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label"))
    .map(r => ({ value: r.Name, label: r.Label ? `${r.Label} (${r.Name})` : r.Name })),
  CustomPermission: async () => (await stdQuery("SELECT DeveloperName, MasterLabel FROM CustomPermission ORDER BY DeveloperName"))
    .map(r => ({ value: r.DeveloperName, label: r.MasterLabel ? `${r.MasterLabel} (${r.DeveloperName})` : r.DeveloperName })),
  GlobalValueSet: async () => (await toolingQuery("SELECT DeveloperName, MasterLabel FROM GlobalValueSet ORDER BY DeveloperName"))
    .map(r => ({ value: r.DeveloperName, label: r.MasterLabel ? `${r.MasterLabel} (${r.DeveloperName})` : r.DeveloperName })),
  RecordType: async () => (await stdQuery("SELECT DeveloperName, Name, SobjectType FROM RecordType ORDER BY SobjectType, DeveloperName"))
    .map(r => ({ value: `${r.SobjectType}.${r.DeveloperName}`, label: `${r.SobjectType} · ${r.Name || r.DeveloperName}` })),
  QuickAction: async () => (await toolingQuery("SELECT DeveloperName, SobjectType FROM QuickActionDefinition ORDER BY DeveloperName"))
    .map(r => ({ value: r.SobjectType && r.SobjectType !== "Global" ? `${r.SobjectType}.${r.DeveloperName}` : r.DeveloperName,
                 label: `${r.SobjectType || "Global"} · ${r.DeveloperName}` })),
  Flow: async () => {
    try {
      return (await stdQuery("SELECT ApiName, Label FROM FlowDefinitionView ORDER BY Label"))
        .map(r => ({ value: r.ApiName, label: `${r.Label} (${r.ApiName})` }));
    } catch {
      return (await toolingQuery("SELECT DeveloperName FROM FlowDefinition ORDER BY DeveloperName"))
        .map(r => ({ value: r.DeveloperName, label: r.DeveloperName }));
    }
  },
  CustomLabel: async () => (await toolingQuery("SELECT Name, MasterLabel FROM ExternalString ORDER BY Name"))
    .map(r => ({ value: r.Name, label: r.MasterLabel ? `${r.MasterLabel} (${r.Name})` : r.Name })),
};


function renderDepObjOptions() {
  const q = $("depObjFilter").value.trim().toLowerCase();
  const current = $("depObj").value;
  const list = (allObjects || []).filter(s =>
    !q || s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  $("depObj").innerHTML = list.slice(0, 500).map(s =>
    `<option value="${escHtml(s.name)}">${escHtml(s.label)} (${escHtml(s.name)})</option>`).join("")
    || `<option value="">No objects match</option>`;
  if (current && list.some(s => s.name === current)) $("depObj").value = current;
  return $("depObj").value;
}

function renderDepItems() {
  const q = $("depFilter").value.trim().toLowerCase();
  const list = depNames.filter(n => !q || n.label.toLowerCase().includes(q) || n.value.toLowerCase().includes(q));
  $("depItem").innerHTML = list.slice(0, 500).map(n =>
    `<option value="${escHtml(n.value)}">${escHtml(n.label)}</option>`).join("")
    || `<option value="">Nothing matches</option>`;
  $("depHint").innerHTML = `(${list.length} of ${depNames.length} shown)`;
}

async function loadDepNames() {
  const type = $("depType").value;
  const isField = type === "CustomField";
  $("depObjWrap").style.display = isField ? "block" : "none";
  $("depItemLabel").textContent = isField ? "Field" : "Component";
  $("depItem").innerHTML = `<option value="">Loading…</option>`;
  try {
    if (isField) {
      await loadObjectList();
      const obj = renderDepObjOptions();
      if (!obj) { depNames = []; renderDepItems(); return; }
      const d = descCache[obj] = descCache[obj] || await api(`/sobjects/${obj}/describe/`);
      // the Dependency API keys custom fields by field name alone
      depNames = (d.fields || []).filter(f => f.custom)
        .map(f => ({ value: f.name, label: `${obj} · ${f.label} (${f.name})`, obj }));
      if (!depNames.length) $("depHint").innerHTML = "(this object has no custom fields)";
    } else {
      const source = DEP_SOURCES[type];
      depNames = source ? await source() : [];
      if (!depNames.length) $("depHint").innerHTML = "(nothing of this type in the org, or it is not queryable here)";
    }
    $("depFilter").value = "";
    renderDepItems();
    depsInited = true;
    setStatus("");
  } catch (err) {
    $("depItem").innerHTML = `<option value="">Could not load</option>`;
    setStatus(`Could not load ${type} list: ${err.message}`, "err");
  }
}

async function collectDepUsages() {
  const type = $("depType").value;
  const name = ($("depItem").value || "").trim();
  if (!name) throw new Error("Pick a component from the list.");
  const objName = type === "CustomField" ? $("depObj").value : "";
  const label = objName ? `${objName}.${name}` : name;
  setStatus(`Finding usages of ${type} '${label}'…`, "busy");
  const { recs, exact, scanned } = await dependencyUsages({ type, name, objName });
  return { type, name: label, recs, exact, scanned };
}

async function runDeps() {
  const btn = $("depsBtn");
  btn.disabled = true;
  try {
    const { type, name, recs } = await collectDepUsages();
    const rows = [["Used By (component)","Used-By Type","References","Reference Type"]];
    // the reference side is what was searched for, so it is filled from the request rather
    // than from the row: those columns are not selected any more
    for (const r of recs) rows.push([r.MetadataComponentName, r.MetadataComponentType, name, type]);
    if (!recs.length) rows.push([`(no recorded usages of ${type} '${name}'. The API is beta and coverage is partial.)`, "", "", ""]);
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, rows, "Usages");
    XLSX.writeFile(wb, `${hostOf(auth)}_usages_${name}_${today()}.xlsx`);
    setStatus(`Done, ${recs.length} usages found.`, "ok");
  } catch (e) {
    setStatus(`Dependency lookup failed: ${e.message}. This org may not have the Dependency API (beta) enabled.`, "err");
  } finally { btn.disabled = false; }
}



// ---------- Unused fields (no data AND no references) ----------

// rows: Object, Field, Type, records-with-value, reference count, referenced-by, verdict
async function collectUnusedRows() {
  if (!usageSel.size) throw new Error("Tick at least one object in the list.");
  if (usageSel.size > 5) throw new Error("Maximum 5 objects for the unused scan (it runs several queries per object).");
  const customOnly = $("unusedCustomOnly").checked;
  const rows = [["Object","Field","Type","Records with value","References","Referenced by","Verdict"]];

  const unusedTotal = usageSel.size;
  let unusedIdx = 0;
  for (const obj of usageSel) {
    unusedIdx++;
    setProgress(Math.round((unusedIdx - 1) / unusedTotal * 100));
    setStatus("Analyzing " + obj + "…", "busy");
    let desc;
    try { desc = await api(`/sobjects/${obj}/describe/`); }
    catch (e) { rows.push([obj, "(describe failed)", "", "", "", "", e.message]); continue; }

    let total = 0;
    try {
      const t = await api(`/query/?q=${encodeURIComponent(`SELECT COUNT() FROM ${obj}`)}`);
      total = t.totalSize || 0;
    } catch (e) { rows.push([obj, "(not countable)", "", "", "", "", e.message]); continue; }

    const fields = (desc.fields || [])
      .filter(f => f.aggregatable && f.name !== "Id")
      .filter(f => !customOnly || f.custom);
    if (!fields.length) { rows.push([obj, "(no matching fields)", "", "", "", "", ""]); continue; }

    // 1) population: batched COUNT(field) aggregates
    const populated = new Map();
    for (let i = 0; i < fields.length; i += 20) {
      const chunk = fields.slice(i, i + 20);
      try {
        const soql = `SELECT ${chunk.map(f => `COUNT(${f.name})`).join(", ")} FROM ${obj}`;
        const res = await api(`/query/?q=${encodeURIComponent(soql)}`);
        const rec = (res.records || [])[0] || {};
        chunk.forEach((f, k) => populated.set(f.name, rec[`expr${k}`] ?? 0));
      } catch { chunk.forEach(f => populated.set(f.name, null)); }
      setProgress(Math.round(Math.min(i + 20, fields.length) / fields.length * 100));
      setStatus(`Analyzing ${obj}… ${Math.min(i + 20, fields.length)}/${fields.length} fields`, "busy");
    }

    // 2) references: Dependency API, by field id. Filtering by RefMetadataComponentName is
    // rejected outright in some orgs, which would leave every field looking unreferenced and
    // quietly turn this into a list of fields to delete. Ids are resolved first instead.
    const refs = new Map();
    let depsOk = false;
    const custom = fields.filter(f => f.custom).map(f => f.name);
    const idToField = new Map();
    try {
      const defs = await toolingQuery(
        `SELECT QualifiedApiName, DurableId FROM FieldDefinition ` +
        `WHERE EntityDefinition.QualifiedApiName = '${obj.replace(/'/g, "")}' AND IsCustom = true`);
      for (const d of defs) {
        const id = String(d.DurableId || "").includes(".") ? String(d.DurableId).split(".").pop() : d.DurableId;
        if (id && d.QualifiedApiName) idToField.set(id, d.QualifiedApiName);
      }
    } catch (e) { console.warn("field id resolution failed:", e); }

    const ids = [...idToField.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map(n => `'${n}'`).join(",");
      try {
        const recs = await toolingQuery(
          `SELECT RefMetadataComponentId, MetadataComponentName, MetadataComponentType ` +
          `FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (${chunk})`);
        depsOk = true;
        for (const r of recs) {
          const k = idToField.get(r.RefMetadataComponentId);
          if (!k) continue;
          if (!refs.has(k)) refs.set(k, []);
          refs.get(k).push(`${r.MetadataComponentType}: ${r.MetadataComponentName}`);
        }
      } catch (e) { console.warn("dependency chunk failed:", e); }
      setStatus(`Checking references for ${obj}… ${Math.min(i + 50, ids.length)}/${ids.length}`, "busy");
    }
    if (!ids.length && custom.length) console.warn("no field ids resolved, references unknown for", obj);

    for (const f of fields) {
      const n = populated.get(f.name);
      const used = refs.get(f.name) || [];
      const refCount = depsOk ? used.length : null;
      const noData = n === 0;
      const verdict = !depsOk
        ? (noData ? "No data (references unknown, Dependency API unavailable)" : "Has data")
        : noData && refCount === 0 ? "Likely safe to delete"
        : noData ? "Empty but referenced"
        : refCount === 0 ? "Has data, no references"
        : "In use";
      rows.push([obj, f.name, f.type, n == null ? "(unknown)" : n,
        refCount == null ? "(unknown)" : refCount,
        used.slice(0, 5).join("; ") + (used.length > 5 ? ` (+${used.length - 5})` : ""),
        verdict]);
    }
  }
  setProgress(null);
  return { rows, total: rows.length - 1 };
}

function renderUnusedCard(rows) {
  {
    const body = rows.slice(1);
    const safe = body.filter(r => r[6] === "Likely safe to delete");
    $("unusedResTitle").textContent = [...usageSel].join(", ");
    $("unusedResNote").textContent = body.length
      ? "Sorted as returned; export for the full sheet. Verify before deleting, the Dependency API is beta and misses some reference types."
      : "Nothing returned for this selection.";
    $("unusedResSummary").innerHTML =
      '<span class="r">' + body.length + " fields checked</span>" +
      '<span class="n">' + safe.length + " likely safe to delete</span>" +
      '<span class="e">' + body.filter(r => r[6] === "In use").length + " in use</span>";
    const order = { "Likely safe to delete": 0, "Empty but referenced": 1, "Has data, no references": 2, "In use": 3 };
    const sorted = [...body].sort((a, b) => (order[a[6]] ?? 9) - (order[b[6]] ?? 9));
    $("unusedResList").innerHTML = sorted.slice(0, 500).map(r =>
      "<tr><td>" + escHtml(r[0]) + "</td><td>" + escHtml(r[1]) + "</td><td>" + escHtml(r[2]) + "</td>" +
      "<td>" + escHtml(r[3]) + "</td><td>" + escHtml(r[4]) + "</td><td>" + escHtml(r[5]) + "</td>" +
      '<td class="' + (r[6] === "Likely safe to delete" ? "accNone" : r[6] === "In use" ? "accEdit" : "") + '">' +
      escHtml(r[6]) + "</td></tr>").join("")
      || '<tr><td colspan="7" style="color:var(--faint);">Nothing to show.</td></tr>';
    flashBox("unusedResult");
  }
}

async function runUnused() {
  const btn = $("unusedBtn");
  btn.disabled = true;
  try {
    const { rows } = await collectUnusedRows();
    renderUnusedCard(rows);
    const wb = XLSX.utils.book_new();
    // Sheet one is the whole audit, including fields that hold data: without them there is
    // no evidence behind a verdict. Sheet two is the short list to act on. The old names
    // implied sheet one was already filtered, which made the "Has data" rows look wrong.
    sheetFromRows(wb, rows, "All fields checked", 60);
    const safe = rows.slice(1).filter(r => r[6] === "Likely safe to delete");
    sheetFromRows(wb, safe.length
      ? [rows[0], ...safe]
      : [rows[0], ["(no fields are both empty and unreferenced)", "", "", "", "", "", ""]], "Delete candidates", 60);
    sheetFromRows(wb, [["How to read this"],
      ["Sheet \"All fields checked\" lists every field you selected, whether or not it holds data."],
      ["Sheet \"Delete candidates\" lists only the fields with no data and no detected references."],
      ["Records with value = COUNT(field) over the object's records (data, not metadata)."],
      ["References = components pointing at the field via the Dependency API (beta): layouts, flows, Apex, formulas, reports."],
      ["\"Likely safe to delete\" means no data AND no detected references, always verify before deleting."],
      ["A field can be on a page layout and still hold no data; that shows as \"Empty but referenced\"."]], "Notes");
    XLSX.writeFile(wb, `${hostOf(auth)}_field_cleanup_${today()}.xlsx`);
    setStatus(`Done, ${rows.length - 1} fields checked, ${safe.length} likely safe to delete.`, "ok");
  } catch (err) {
    setStatus("Unused-field export failed: " + err.message, "err");
  } finally { btn.disabled = false; }
}

// ---------- field usage object picker ----------
const usageSel = new Set();
let usageInited = false;

async function initUsage() {
  if (usageInited) return;
  try {
    setStatus("Loading object list…", "busy");
    await loadObjectList();
    usageInited = true;
    setStatus("");
    renderUsageList();
  } catch (err) { setStatus("Could not load objects: " + err.message, "err"); }
}

function renderUsageList() {
  const q = $("usageSearch").value.trim().toLowerCase();
  const list = (allObjects || [])
    .filter(s => !q || s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .slice(0, 300);
  $("usageList").innerHTML = list.map(s =>
    '<label><input type="checkbox" data-uobj="' + escHtml(s.name) + '"' + (usageSel.has(s.name) ? " checked" : "") + '>' +
    hl(s.label, q) + '<span class="api">' + hl(s.name, q) + '</span></label>').join("")
    || '<div style="padding:10px; font-size:13px; color:var(--faint);">No objects match.</div>';
  $("usageCount").textContent = usageSel.size + " selected";
}

function usageObjectList() {
  if (!usageSel.size) throw new Error("Tick at least one object in the list.");
  if (usageSel.size > 10) throw new Error("Maximum 10 objects at a time (aggregate queries are heavy).");
  return [...usageSel];
}

// ---------- Field usage (population %) ----------
async function collectUsageRows() {
  {
    const objs = usageObjectList();
    const rows = [["Object","Field","Type","Records with a value","Total records","% populated","Possibly unused"]];
    for (const obj of objs) {
      setStatus(`Analyzing ${obj}…`, "busy");
      let desc;
      try { desc = await api(`/sobjects/${obj}/describe/`); }
      catch { rows.push([obj, "(describe failed, check the API name)", "", "", "", ""]); continue; }
      let total = 0;
      try {
        const t = await api(`/query/?q=${encodeURIComponent(`SELECT COUNT() FROM ${obj}`)}`);
        total = t.totalSize || 0;
      } catch (e) { rows.push([obj, `(not countable: ${e.message})`, "", "", "", ""]); continue; }
      if (!total) { rows.push([obj, "(no records)", "", 0, 0, ""]); continue; }
      const fields = (desc.fields || []).filter(f => f.aggregatable && f.name !== "Id");
      for (let i = 0; i < fields.length; i += 20) {
        const chunk = fields.slice(i, i + 20);
        try {
          const soql = `SELECT ${chunk.map(f => `COUNT(${f.name})`).join(", ")} FROM ${obj}`;
          const res = await api(`/query/?q=${encodeURIComponent(soql)}`);
          const rec = (res.records || [])[0] || {};
          chunk.forEach((f, j) => {
            const nn = rec[`expr${j}`] ?? 0;
            rows.push([obj, f.name, f.type, nn, total, `${Math.round(nn / total * 100)}%`, nn === 0 ? "Yes" : ""]);
          });
        } catch (e) { chunk.forEach(f => rows.push([obj, f.name, f.type, "(query failed)", total, "", ""])); }
        setProgress(Math.round(Math.min(i + 20, fields.length) / fields.length * 100));
      setStatus(`Analyzing ${obj}… ${Math.min(i + 20, fields.length)}/${fields.length} fields`, "busy");
      }
    }
    setProgress(null);
    return rows;
  }
}

async function runUsage() {
  const btn = $("usageBtn");
  btn.disabled = true;
  try {
    const rows = await collectUsageRows();
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, rows, "Field Usage");
    XLSX.writeFile(wb, `${hostOf(auth)}_field_usage_${today()}.xlsx`);
    setStatus(`Done, ${rows.length - 1} field rows exported.`, "ok");
  } catch (e) {
    setStatus(`Field usage failed: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}



// ---------- progress bar + result-card chrome ----------
function setProgress(pct) {
  const bar = $("bar"), fill = $("barFill");
  if (pct == null) { bar.style.display = "none"; fill.style.width = "0%"; return; }
  bar.style.display = "block";
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

// Every result card gets a dismiss button, and every panel that produces one gets a
// one-line hint so an untouched panel is not just controls over blank space.
const PANEL_HINTS = {
  panelCode: "Search for matching lines, or press “List all files” to browse your Apex, Visualforce, LWC and Aura source.",
  panelSoql: "Results appear here as a table you can read or export.",
  panelAudit: "Pick a date, then every Setup change appears here with who made it.",
  panelTests: "Coverage per class and recent test failures appear here.",
  panelCounts: "Record volume per object appears here, biggest first.",
  panelJobs: "Scheduled jobs and recent failures appear here.",
  panelPackage: "Pick a date, then the changed components appear here with a package.xml.",
  panelCompare: "Connect a second org, then a per-type difference summary appears here.",
  panelPerms: "Tick objects, then object CRUD per profile and permission set appears here.",
  panelProfCmp: "Choose two profiles or permission sets, then their differences appear here.",
  panelUserAccess: "Search a user, then their effective access appears here with its source.",
  panelAuto: "Everything that fires on record changes appears here, triggers, flows, workflow rules.",
  panelDeps: "Pick a component, then the things referencing it appear here.",
  panelUsage: "Tick objects, then field population and cleanup candidates appear here.",
  panelErd: "Pick objects, then their relationship diagram is drawn here.",
};

function installResultChrome() {
  // codeViewer is not a result box: it is not cleared between panels, so it only gets a
  // copy button, not a dismiss one
  for (const id of [...RESULT_BOXES, "codeViewer"]) {
    const box = $(id);
    if (!box || box.querySelector(".boxclose")) continue;
    const hdr = box.querySelector(".fieldhdr");
    if (!hdr) continue;
    const copy = document.createElement("button");
    copy.className = "boxcopy";
    copy.title = "Copy what is shown. A table pastes as a table into Excel, Teams, Word or " +
      "Jira, and as aligned columns into Slack. Source copies as code, a diagram as SVG";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyResultBox(id, copy));
    hdr.appendChild(copy);
    if (id === "codeViewer") continue;          // nothing to dismiss, the tabs own this pane
    const btn = document.createElement("button");
    btn.className = "boxclose";
    btn.title = "Dismiss";
    btn.textContent = "\u00d7";
    btn.addEventListener("click", () => { box.style.display = "none"; showPanelHint(); });
    hdr.appendChild(btn);
  }
  for (const [panel, text] of Object.entries(PANEL_HINTS)) {
    const p = $(panel);
    if (!p || p.querySelector(".emptyhint")) continue;
    const div = document.createElement("div");
    div.className = "emptyhint";
    div.textContent = text;
    p.appendChild(div);
  }
}

// show the hint only while that panel has no visible result card
function showPanelHint() {
  for (const panel of Object.keys(PANEL_HINTS)) {
    const p = $(panel);
    if (!p) continue;
    const hint = p.querySelector(".emptyhint");
    if (!hint) continue;
    const hasResult = [...p.querySelectorAll(".resultbox, #permResult, #autoResult, #usageResult, #depsResult, #pkgResult, #unusedResult, #profResult, #orgResult, #uaResult, #soqlResult, #codeResult")]
      .some(b => b.style.display === "block");
    hint.style.display = hasResult ? "none" : "block";
  }
}

// ---------- on-screen result helpers ----------
function flashBox(id) {
  const box = $(id);
  box.style.display = "block";
  showPanelHint();
  box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Field usage on screen
async function showUsage() {
  const btn = $("usageShowBtn");
  btn.disabled = true;
  try {
    const rows = await collectUsageRows();
    const body = rows.slice(1);
    $("usageResTitle").textContent = [...usageSel].join(", ");
    const unused = body.filter(r => r[6] === "Yes").length;
    $("usageResNote").textContent = body.length
      ? "Percentages are of the object's total record count."
      : "Nothing returned for this selection.";
    $("usageResSummary").innerHTML =
      '<span class="r">' + body.length + " fields</span>" +
      '<span class="n">' + unused + " possibly unused</span>";
    $("usageResList").innerHTML = body.slice(0, 500).map(r =>
      "<tr><td>" + escHtml(r[0]) + "</td><td>" + escHtml(r[1]) + "</td><td>" + escHtml(r[2]) + "</td>" +
      "<td>" + escHtml(r[3]) + "</td><td>" + escHtml(r[4]) + "</td><td>" + escHtml(r[5]) + "</td>" +
      '<td class="' + (r[6] === "Yes" ? "accNone" : "") + '">' + escHtml(r[6]) + "</td></tr>").join("")
      || '<tr><td colspan="7" style="color:var(--faint);">Nothing to show.</td></tr>';
    flashBox("usageResult");
    setStatus("");
  } catch (err) {
    setStatus("Field usage failed: " + err.message, "err");
  } finally { btn.disabled = false; }
}

// Dependencies on screen
async function showDeps() {
  const btn = $("depsShowBtn");
  btn.disabled = true;
  try {
    const { type, name, recs, exact, scanned } = await collectDepUsages();
    $("depsResTitle").textContent = type + " " + name;
    $("depsResNote").textContent = (recs.length
      ? "Components that reference this one (Dependency API, beta, coverage is partial)."
      : "No recorded usages. The Dependency API is beta, so absence is not proof it is unused.")
      + (exact === false ? " Note: matched by field name, so results may include same-named fields on other objects." : "")
      + (scanned ? ` Rows marked "in source" were found by reading Visualforce, Apex, component and flow ` +
          `definitions, because a component referenced by name is invisible to the Dependency API. ` +
          `${scanned.flowsChecked} active flow${scanned.flowsChecked === 1 ? "" : "s"} read` +
          `${scanned.flowsCapped ? ", capped at 120" : ""}.` : "");
    const byType = {};
    for (const r of recs) byType[r.MetadataComponentType] = (byType[r.MetadataComponentType] || 0) + 1;
    $("depsResSummary").innerHTML = Object.entries(byType).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => '<span class="r">' + n + " " + escHtml(t) + "</span>").join("")
      || '<span class="n">none found</span>';
    $("depsResList").innerHTML = recs.slice(0, 500).map(r =>
      "<tr><td>" + escHtml(r.MetadataComponentName) + "</td><td>" + escHtml(r.MetadataComponentType) +
      // where a row came from matters: one is the platform's own record, the other is a read
      (r.fromSource ? ' <span class="ftype">in source</span>' : "") + "</td></tr>").join("")
      || '<tr><td colspan="2" style="color:var(--faint);">Nothing to show.</td></tr>';
    flashBox("depsResult");
    setStatus("");
  } catch (err) {
    setStatus("Dependency lookup failed: " + err.message, "err");
  } finally { btn.disabled = false; }
}

// Deployment changes on screen
async function showPackage() {
  const btn = $("packageShowBtn");
  btn.disabled = true;
  try {
    const { sinceRaw, changes, coverage } = await collectChanges();
    $("pkgResTitle").textContent = "since " + sinceRaw;
    $("pkgResNote").textContent = changes.length
      ? "Coverage: " + coverage + ". Export to get the full sheet plus a ready-to-use package.xml."
      : "No changes found since " + sinceRaw + " (coverage: " + coverage + ").";
    const byType = {};
    for (const c of changes) byType[c.type] = (byType[c.type] || 0) + 1;
    $("pkgResSummary").innerHTML =
      '<span class="r">' + changes.length + " components</span>" +
      Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([t, n]) => '<span class="r">' + n + " " + escHtml(t) + "</span>").join("");
    $("pkgResList").innerHTML = changes.slice(0, 500).map(c =>
      "<tr><td>" + escHtml(c.type) + "</td><td>" + escHtml(c.member) + "</td>" +
      '<td class="' + (c.flag === "Deleted" ? "accNone" : c.flag === "New" ? "accEdit" : "") + '">' + escHtml(c.flag) + "</td>" +
      "<td>" + escHtml(c.modified) + "</td><td>" + escHtml(c.modifiedBy) + "</td></tr>").join("")
      || '<tr><td colspan="5" style="color:var(--faint);">Nothing to show.</td></tr>';
    flashBox("pkgResult");
    setStatus("");
  } catch (err) {
    setStatus("Could not load changes: " + err.message, "err");
  } finally { btn.disabled = false; }
}

// ---------- Org health snapshot workbook ----------
async function downloadSnapshot() {
  const btn = $("snapshotBtn");
  btn.disabled = true;
  try {
    setStatus("Building health snapshot…", "busy");
    const wb = XLSX.utils.book_new();
    await buildHealthSheets(wb);
    XLSX.writeFile(wb, `${hostOf(auth)}_health_${today()}.xlsx`);
    setStatus("Health snapshot downloaded.", "ok");
  } catch (e) {
    setStatus(`Snapshot failed: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}

async function buildHealthSheets(wb) {
  {
    const [limits, licRows, profRows] = await Promise.all([
      api("/limits/"),
      stdQuery("SELECT Name, Status, TotalLicenses, UsedLicenses FROM UserLicense ORDER BY Name"),
      stdQuery("SELECT Profile.Name pname, COUNT(Id) c FROM User WHERE IsActive = true GROUP BY Profile.Name ORDER BY COUNT(Id) DESC"),
    ]);
    const limRows = [["Limit","Max","Remaining","Used","% used"]];
    for (const [k, o] of Object.entries(limits).sort()) {
      if (!o || typeof o.Max !== "number") continue;
      const used = o.Max - o.Remaining;
      limRows.push([k, o.Max, o.Remaining, used, o.Max ? `${Math.round(used / o.Max * 100)}%` : ""]);
    }
    const licSheet = [["License","Status","Total","Used","Remaining"]];
    for (const r of licRows) licSheet.push([r.Name, r.Status, r.TotalLicenses, r.UsedLicenses, (r.TotalLicenses ?? 0) - (r.UsedLicenses ?? 0)]);
    const profSheet = [["Profile","Active users"]];
    for (const r of profRows) profSheet.push([r.pname ?? r.Name ?? "", r.c ?? r.expr0 ?? 0]);

    sheetFromRows(wb, limRows, "Limits");
    const inv = invCache || await fetchInventory();
    if (inv.length) sheetFromRows(wb, [["Component","Count"], ...inv.map(x => [x.label, x.value])], "Inventory");
    sheetFromRows(wb, licSheet, "User Licenses");
    sheetFromRows(wb, profSheet, "Users by Profile");
  }
}

// ---------- one-click full org audit ----------
async function runFullAudit() {
  const btn = $("auditBtn");
  btn.disabled = true;
  $("bar").style.display = "block";
  try {
    const wb = XLSX.utils.book_new();
    setStatus("Full audit 1/4, org health…", "busy");
    try { await buildHealthSheets(wb); } catch (e) { console.warn("audit health skipped:", e); }

    setStatus("Full audit 2/4, describing all objects…", "busy");
    const objs = await loadObjectList();
    const describes = {};
    let done = 0;
    const queue = objs.map(s => s.name);
    async function worker() {
      while (queue.length) {
        const name = queue.shift();
        try { describes[name] = await api(`/sobjects/${name}/describe/`); }
        catch (e) { console.warn("describe failed", name, e); }
        done++;
        $("barFill").style.width = `${Math.round(done / objs.length * 100)}%`;
        setStatus(`Full audit 2/4, describing objects… ${done}/${objs.length}`, "busy");
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const { names } = buildCoreSheets(wb, describes, true);

    setStatus("Full audit 3/4, validation rules…", "busy");
    const vrRows = await fetchVRRows(new Set(names));
    if (vrRows) sheetFromRows(wb, vrRows, "Validation Rules", 60);

    setStatus("Full audit 4/5, automation…", "busy");
    try {
      const autoRows = await collectAutomationRows(new Set());
      sheetFromRows(wb, autoRows.length > 1 ? autoRows : [...autoRows, ["(no automation found)","","","","",""]], "Automation", 60);
    } catch (e) { console.warn("audit automation skipped:", e); }

    setStatus("Full audit 5/5, code inventory…", "busy");
    try {
      const codeRows = await collectCodeRows();
      sheetFromRows(wb, codeRows.length > 1 ? codeRows : [...codeRows, ["(no code found)","","","","","","",""]], "Code Inventory", 50);
    } catch (e) { console.warn("audit code skipped:", e); }

    XLSX.writeFile(wb, `${hostOf(auth)}_full_audit_${today()}.xlsx`);
    setStatus(`Full audit done, ${names.length} objects across ${wb.SheetNames.length} sheets.`, "ok");
  } catch (e) {
    setStatus(`Full audit failed: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
    $("bar").style.display = "none";
    $("barFill").style.width = "0%";
  }
}

// ---------- Object browser ----------
const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// escape + wrap the search-term matches in <mark>
function hl(text, q) {
  const s = escHtml(text);
  if (!q) return s;
  const eq = escHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`(${eq})`, "ig"), "<mark>$1</mark>");
}
const descCache = {};
let browserInited = false;

async function initBrowser() {
  if (browserInited) return;
  browserInited = true;
  try {
    setStatus("Loading object list…", "busy");
    await loadObjectList();
    setStatus("");
    renderBrowserObjects();
  } catch (e) { browserInited = false; setStatus(`Could not load objects: ${e.message}`, "err"); }
}

function renderBrowserObjects() {
  const q = $("bSearch").value.trim().toLowerCase();
  const list = (allObjects || [])
    .filter(s => !q || s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    .slice(0, 300);
  $("bObjList").innerHTML = list.map(s =>
    `<tr class="objrow${s.name === bSelectedObj ? " sel" : ""}" data-obj="${escHtml(s.name)}"><td>${hl(s.label, q)}</td>` +
    `<td class="mono">${hl(s.name, q)}</td><td>${s.custom ? "Yes" : ""}</td></tr>`
  ).join("") || `<tr><td colspan="3">No objects match.</td></tr>`;
}

let bFields = [];
let bCurrentObj = "";
let bSelectedObj = null;
async function openBrowserObject(name) {
  try {
    setStatus(`Loading ${name}…`, "busy");
    descCache[name] = descCache[name] || await api(`/sobjects/${name}/describe/`);
    setStatus("");
    const d = descCache[name];
    bCurrentObj = name;
    bSelectedObj = name;
    bSelectedField = null;
    $("bFLSInline").style.display = "none";
    $("bRTInline").style.display = "none";
    $("bRefsBox").style.display = "none";
    bFields = d.fields || [];
    $("bObjTitle").textContent = `${d.label} (${name}), ${bFields.length} fields`;
    $("bFieldSearch").value = "";
    renderBrowserFields();
    $("bObjView").style.display = "none";
    $("bFieldView").style.display = "block";
    showObjectOwd(name);
  } catch (e) { setStatus(`Describe failed: ${e.message}`, "err"); }
}

function fieldDetails(f) {
  const bits = [];
  if (f.calculated) bits.push(f.calculatedFormula
    ? `= ${f.calculatedFormula.slice(0, 150)}${f.calculatedFormula.length > 150 ? "…" : ""}`
    : "formula");
  if (f.unique) bits.push("unique");
  if (f.externalId) bits.push("external id");
  if ((f.referenceTo || []).length) bits.push("→ " + f.referenceTo.join(", "));
  if (f.length && ["string", "textarea", "phone", "url", "email"].includes(f.type)) bits.push(`len ${f.length}`);
  return bits.join(" · ");
}

function detailsCell(f) {
  let html = escHtml(fieldDetails(f));
  const n = (f.picklistValues || []).length;
  if (n) html += `${html ? " · " : ""}<a class="pklink" data-pk="${escHtml(f.name)}">${n} value${n > 1 ? "s" : ""}</a>`;
  return html;
}

function openPicklistModal(fieldName) {
  const f = bFields.find(x => x.name === fieldName);
  if (!f) return;
  $("pkTitle").textContent = `${bCurrentObj}.${f.name}, ${(f.picklistValues || []).length} picklist values`;
  $("pkList").innerHTML = (f.picklistValues || []).map(v =>
    `<tr><td class="mono">${escHtml(v.value)}</td><td>${escHtml(v.label || v.value)}</td>` +
    `<td>${v.active ? "Yes" : `<span class="accNone">No</span>`}</td><td>${v.defaultValue ? "Yes" : ""}</td></tr>`
  ).join("");
  $("pkOverlay").classList.add("open");
}

let bSelectedField = null;
function renderBrowserFields() {
  const q = $("bFieldSearch").value.trim().toLowerCase();
  const list = bFields.filter(f => !q || f.label.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
  $("bFieldList").innerHTML = list.map(f =>
    `<tr class="objrow${f.name === bSelectedField ? " sel" : ""}" data-field="${escHtml(f.name)}"><td>${hl(f.label, q)}</td><td class="mono">${hl(f.name, q)}</td><td>${escHtml(f.type)}</td>` +
    `<td>${(!f.nillable && f.createable) ? "Yes" : ""}</td><td>${detailsCell(f)}</td></tr>`
  ).join("") || `<tr><td colspan="5">No fields match.</td></tr>`;
}

// field-level security view: access per profile (complete, None highlighted) + granting perm sets
let profileListCache = null;
async function openFieldFLS(fieldName) {
  try {
    setStatus(`Loading access for ${fieldName}…`, "busy");
    profileListCache = profileListCache || await stdQuery(
      "SELECT Id, ProfileId, Profile.Name FROM PermissionSet WHERE IsOwnedByProfile = true ORDER BY Profile.Name");
    const key = `${bCurrentObj}.${fieldName}`;
    const fp = await stdQuery(
      `SELECT ParentId, Parent.Label, Parent.IsOwnedByProfile, PermissionsRead, PermissionsEdit ` +
      `FROM FieldPermissions WHERE SobjectType = '${bCurrentObj}' AND Field = '${key}'`);
    setStatus("");
    const acc = (r) => r.PermissionsEdit ? "Edit" : r.PermissionsRead ? "Read" : "None";
    const byParent = new Map(fp.map(r => [r.ParentId, r]));
    const cell = (a) => `<td class="acc${a}">${a === "None" ? "✕ None" : a === "Edit" ? "✓ Edit" : "✓ Read"}</td>`;
    // Two wrong turns before this one. A classic edit URL with ?s=EntityPermissions, to land
    // straight on this object's settings, is rejected by the Lightning profile UI. A bare
    // record id resolves, but Salesforce serves profiles through the Classic page, which
    // throws you out of Lightning. The Setup wrapper with the id as its address keeps you in
    // Lightning and still lands on the right record.
    const profUrl = (pid) => setupUrl.profile(pid);
    const psUrl = (id) => setupUrl.permSet(id);

    const profRows = profileListCache.map(p => {
      const a = byParent.has(p.Id) ? acc(byParent.get(p.Id)) : "None";
      return `<tr class="objrow" data-url="${escHtml(profUrl(p.ProfileId))}" title="Open profile in Setup"><td>${escHtml(p.Profile?.Name || "(profile)")}</td><td>Profile</td>${cell(a)}</tr>`;
    });
    const psRows = fp.filter(r => !r.Parent?.IsOwnedByProfile).map(r =>
      `<tr class="objrow" data-url="${escHtml(psUrl(r.ParentId))}" title="Open permission set in Setup"><td>${escHtml(r.Parent?.Label || r.ParentId)}</td><td>Permission Set</td>${cell(acc(r))}</tr>`);

    $("bFLSTitle").textContent = key;
    const permissionable = fp.length > 0;
    if (permissionable) {
      const counts = { Edit: 0, Read: 0, None: 0 };
      for (const p of profileListCache) counts[byParent.has(p.Id) ? acc(byParent.get(p.Id)) : "None"]++;
      $("bFLSSummary").innerHTML =
        `<span class="e">${counts.Edit} can edit</span><span class="r">${counts.Read} read only</span>` +
        `<span class="n">${counts.None} no access</span>` +
        (psRows.length ? `<span class="r">${psRows.length} permission set${psRows.length > 1 ? "s" : ""}</span>` : "");
      $("bFLSNote").textContent = `${profileListCache.length} profiles checked. Click a row to open ${bCurrentObj} settings inside that profile or permission set, where this field's security is edited.`;
      $("bFLSList").innerHTML = [...profRows, ...psRows].join("");
    } else {
      $("bFLSSummary").innerHTML = `<span class="r">Visible to everyone</span>`;
      $("bFLSNote").textContent =
        "This field has no field-level security records, it is not permissionable (system, required, or standard-audit field), so every profile can see it.";
      $("bFLSList").innerHTML = `<tr><td colspan="3" style="color:var(--faint);">No per-profile settings exist for this field.</td></tr>`;
    }
    bSelectedField = fieldName;
    $("bRefsBox").style.display = "none";
    for (const tr of $("bFieldList").querySelectorAll("tr")) {
      tr.classList.toggle("sel", tr.dataset.field === fieldName);
    }
    const box = $("bFLSInline");
    box.style.display = "block";
    box.classList.remove("flash");
    void box.offsetWidth; // restart the flash animation
    box.classList.add("flash");
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) { setStatus(`FLS lookup failed: ${e.message}`, "err"); }
}



// --- field references, straight from the object browser (no typing an API name) ---
async function showFieldReferences() {
  const btn = $("bRefsBtn");
  btn.disabled = true;
  try {
    if (!bSelectedField) throw new Error("Pick a field first.");
    setStatus(`Finding usages of ${bCurrentObj}.${bSelectedField}…`, "busy");
    const { recs, exact } = await dependencyUsages({ type: "CustomField", name: bSelectedField, objName: bCurrentObj });
    setStatus("");
    const byType = {};
    for (const r of recs) byType[r.MetadataComponentType] = (byType[r.MetadataComponentType] || 0) + 1;
    $("bRefsNote").textContent = (recs.length
      ? `${recs.length} component${recs.length === 1 ? "" : "s"} reference ${bCurrentObj}.${bSelectedField}.`
      : `Nothing references ${bCurrentObj}.${bSelectedField} according to the Dependency API. It is beta, so treat this as a strong hint rather than proof.`)
      + (exact ? "" : " Matched by field name, so other objects' fields with this name may be included.");
    $("bRefsSummary").innerHTML = Object.entries(byType).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="r">${n} ${escHtml(t)}</span>`).join("") || `<span class="n">no references</span>`;
    $("bRefsList").innerHTML = recs.slice(0, 300).map(r =>
      `<tr><td>${escHtml(r.MetadataComponentName)}</td><td>${escHtml(r.MetadataComponentType)}</td></tr>`).join("")
      || `<tr><td colspan="2" style="color:var(--faint);">Nothing to show.</td></tr>`;
    $("bRefsBox").style.display = "block";
  } catch (err) {
    setStatus(`Reference lookup failed: ${err.message}. This org may not have the Dependency API (beta) enabled.`, "err");
  } finally { btn.disabled = false; }
}

// --- open the field itself in Setup (Object Manager), where its FLS button lives ---
async function openFieldInSetup() {
  const btn = $("bFieldSetupBtn");
  btn.disabled = true;
  try {
    if (!bSelectedField) throw new Error("Pick a field first.");
    const base = baseUrl() + SETUP_PATH.objectManager + encodeURIComponent(bCurrentObj);
    let url = `${base}/FieldsAndRelationships/view`;
    try {
      // FieldDefinition.DurableId is what Object Manager uses in the field URL
      const fd = await toolingQuery(
        `SELECT DurableId FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${bCurrentObj}' ` +
        `AND QualifiedApiName = '${bSelectedField.replace(/'/g, "")}' LIMIT 1`);
      const durable = fd[0]?.DurableId;
      if (durable) {
        const id = durable.includes(".") ? durable.split(".").pop() : durable;
        url = `${base}/FieldsAndRelationships/${encodeURIComponent(id)}/view`;
      }
    } catch (e) { console.warn("FieldDefinition lookup failed, opening the field list instead:", e); }
    window.open(url, "_blank", "noopener");
  } catch (err) {
    setStatus(err.message, "err");
  } finally { btn.disabled = false; }
}

// Record-type access for the object currently open in the browser.
// Salesforce exposes this per permission-set-container, so profiles and permission
// sets both come from the same query.
async function openRecordTypeAccess() {
  const btn = $("bRTBtn");
  btn.disabled = true;
  try {
    if (!bCurrentObj) throw new Error("Open an object first.");
    setStatus(`Loading record-type access for ${bCurrentObj}…`, "busy");
    const rts = await stdQuery(
      `SELECT Id, DeveloperName, Name, IsActive FROM RecordType WHERE SobjectType = '${bCurrentObj}' ORDER BY DeveloperName`);
    if (!rts.length) {
      $("bRTTitle").textContent = bCurrentObj;
      $("bRTNote").textContent = "This object has no record types.";
      $("bRTList").innerHTML = `<tr><td colspan="5" style="color:var(--faint);">Nothing to show.</td></tr>`;
    } else {
      const ids = rts.map(r => `'${r.Id}'`).join(",");
      const nameById = new Map(rts.map(r => [r.Id, `${r.Name || r.DeveloperName}${r.IsActive ? "" : " (inactive)"}`]));
      const who = r => r.Parent?.IsOwnedByProfile ? (r.Parent?.Profile?.Name || r.Parent?.Label) : r.Parent?.Label;

      // Per-profile record-type visibility lives on Tooling objects, and which one exists
      // varies by org/API version — try each, then fall back to what the describe gives us.
      let rtv = null;
      const attempts = [
        [toolingQuery, `SELECT RecordTypeId, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, Visible, DefaultRecordTypeMapping FROM RecordTypeVisibility WHERE RecordTypeId IN (${ids})`],
        [toolingQuery, `SELECT RecordTypeId, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, Visible, Default FROM PermissionSetRecordTypeVisibility WHERE RecordTypeId IN (${ids})`],
      ];
      for (const [runner, soql] of attempts) {
        try { rtv = await runner(soql); break; }
        catch (e) { console.warn("record-type visibility attempt failed:", e.message); }
      }

      $("bRTTitle").textContent = `${bCurrentObj} · ${rts.length} record type${rts.length > 1 ? "s" : ""}`;

      if (rtv) {
        const visible = rtv.filter(r => r.Visible);
        $("bRTNote").textContent = visible.length
          ? "Rows show who can see each record type. Click a row to open it in Salesforce Setup."
          : "No profile or permission set grants visibility to these record types.";
        $("bRTList").innerHTML = visible.map(r => {
          const url = r.Parent?.IsOwnedByProfile
            ? baseUrl() + SETUP_PATH.profileList
            : baseUrl() + SETUP_PATH.permSetList;
          return `<tr class="objrow" data-url="${escHtml(url)}"><td>${escHtml(nameById.get(r.RecordTypeId) || r.RecordTypeId)}</td>` +
            `<td>${escHtml(who(r) || "")}</td><td>${r.Parent?.IsOwnedByProfile ? "Profile" : "Permission Set"}</td>` +
            `<td class="accEdit">✓ Yes</td><td>${(r.DefaultRecordTypeMapping || r.Default) ? "Default" : ""}</td></tr>`;
        }).join("") || `<tr><td colspan="5" style="color:var(--faint);">Nothing to show.</td></tr>`;
      } else {
        // Fallback: the object describe reports record types as they apply to YOU.
        const d = descCache[bCurrentObj];
        const infos = (d?.recordTypeInfos || []).filter(r => !r.master);
        $("bRTNote").textContent =
          "This org does not expose per-profile record-type visibility to the API, so the rows below " +
          "show the record types as they apply to you (the signed-in user). For the full per-profile " +
          "matrix, retrieve the profiles with the Salesforce CLI.";
        $("bRTList").innerHTML = infos.map(r =>
          `<tr><td>${escHtml(r.name)}${r.active === false ? " (inactive)" : ""}</td>` +
          `<td>${escHtml(auth.instanceUrl.replace("https://", ""))} (you)</td><td>Current user</td>` +
          `<td class="${r.available ? "accEdit" : "accNone"}">${r.available ? "✓ Yes" : "✕ No"}</td>` +
          `<td>${r.defaultRecordTypeMapping ? "Default" : ""}</td></tr>`).join("")
          || `<tr><td colspan="5" style="color:var(--faint);">This object has no record types.</td></tr>`;
      }
    }
    setStatus("");
    const box = $("bRTInline");
    box.style.display = "block";
    box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash");
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    setStatus(`Record-type access failed: ${err.message}`, "err");
  } finally { btn.disabled = false; }
}

// ---------- Profile / permission set compare (same org or across two orgs) ----------
let profsLoaded = false;

// Any org the browser currently has a Salesforce session for can be compared — we fetch
// its session on demand, so the user does not have to "connect" it first.
const sessionByHost = new Map();
async function sessionForHost(host) {
  if (!host) throw new Error("No org selected.");
  if (auth && hostOf(auth) === host.split(".")[0] && auth.instanceUrl === "https://" + host) return auth;
  if (auth2 && auth2.instanceUrl === "https://" + host) return auth2;
  if (sessionByHost.has(host)) return sessionByHost.get(host);
  const r = await ask({ type: "session", host });
  if (!r?.ok) throw new Error(r?.error || ("No active session for " + host));
  const a = { accessToken: r.session.token, instanceUrl: "https://" + host };
  sessionByHost.set(host, a);
  return a;
}

async function cmpOrgs() {
  const r = await ask({ type: "listOrgs" });
  const orgs = (r?.ok && r.orgs?.length) ? r.orgs.map(o => ({ host: o.host, label: o.label || o.host })) : [];
  if (auth) {
    const host = auth.instanceUrl.replace("https://", "");
    if (!orgs.some(o => o.host === host)) orgs.unshift({ host, label: hostOf(auth) });
  }
  return orgs;
}

// One row per profile or per permission set. The PermissionSet Id is the key used by
// every permission-detail object (ObjectPermissions, FieldPermissions, SetupEntityAccess…),
// which is why the same comparison works for both kinds.
async function listContainers(a, kind) {
  return kind === "profile"
    ? stdQueryFor(a, "SELECT Id, ProfileId, Profile.Name FROM PermissionSet WHERE IsOwnedByProfile = true ORDER BY Profile.Name")
    : stdQueryFor(a, "SELECT Id, Label, Name FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label");
}
const containerName = (r, kind) => kind === "profile" ? (r.Profile?.Name || r.Id) : (r.Label || r.Name || r.Id);

async function fillContainerSelect(side) {
  const kind = $("cmpKind").value;
  const sel = $("prof" + side);
  try {
    sel.innerHTML = "<option value=\"\">Loading…</option>";
    const a = await sessionForHost($("profOrg" + side).value);
    const recs = await listContainers(a, kind);
    sel.innerHTML = recs.map(r => "<option value=\"" + escHtml(r.Id) + "\"" +
      (r.ProfileId ? " data-pid=\"" + escHtml(r.ProfileId) + "\"" : "") + ">" +
      escHtml(containerName(r, kind)) + "</option>").join("")
      || "<option value=\"\">None found</option>";
    if (side === "B" && recs.length > 1 && $("profOrgB").value === $("profOrgA").value) sel.selectedIndex = 1;
    if (side !== "A" && side !== "B" && recs.length) {
      // a third side on the same org as A defaults to the same name, which is the usual intent
      const want = $("profA").selectedOptions[0]?.textContent;
      const hit = [...sel.options].find(o => o.textContent === want);
      if (hit && $("profOrg" + side).value !== $("profOrgA").value) sel.value = hit.value;
    }
  } catch (err) {
    sel.innerHTML = "<option value=\"\">Could not load</option>";
    setStatus("Could not load list: " + err.message, "err");
  }
}

let profSlots = ["A", "B"];      // slot letters on screen; A and B keep the ids the diff path reads
let profOrgList = [];

const PROF_LETTERS = "ABCDEFGH";

async function initProfCmp(force = false) {
  if (profsLoaded && !force) return;
  profOrgList = await cmpOrgs();
  renderProfSlots();
  $("profOrgHint").innerHTML = profOrgList.length > 1
    ? "(" + profOrgList.length + " logged-in orgs; set a different org on a side to compare across orgs)"
    : "(log into another org in a new tab, then Reload lists, to compare across orgs)";
  setStatus("Loading lists…", "busy");
  await Promise.all(profSlots.map(s => fillContainerSelect(s)));
  profsLoaded = true;
  setStatus("");
}

// Slot A is the org you are signed into; every other slot picks its own org and name.
function renderProfSlots() {
  const mine = auth ? apiHostOf(auth) : "";
  const keep = {};
  for (const s of profSlots) {
    keep[s] = { org: $("profOrg" + s)?.value || "", id: $("prof" + s)?.value || "",
                html: $("prof" + s)?.innerHTML || "" };
  }
  $("profSlots").innerHTML = profSlots.map((s, i) => {
    const chosen = keep[s]?.org || (i === 0 ? mine : (profOrgList[i]?.host || mine));
    const opts = profOrgList.map(o =>
      `<option value="${escHtml(o.host)}" ${o.host === chosen ? "selected" : ""}>${escHtml(o.label)}</option>`).join("");
    return `<div class="profslot ${i === 0 ? "fixed" : ""}">
      <div class="shead"><span class="sidehdr"><span class="tag">${s}</span>Side ${s}</span>
        ${i > 1 ? `<button class="drop" data-profdrop="${s}" title="Remove this side">&times;</button>` : ""}</div>
      <label for="profOrg${s}">Org</label>
      <select id="profOrg${s}">${opts || '<option value="">No logged-in org found</option>'}</select>
      <label for="prof${s}">Name</label>
      <select id="prof${s}">${keep[s]?.html || '<option value="">Loading…</option>'}</select>
    </div>`;
  }).join("");
  for (const s of profSlots) if (keep[s]?.id) $("prof" + s).value = keep[s].id;
  const many = profSlots.length > 2;
  $("profShowLabel").textContent = many ? "Show matrix" : "Show comparison";
  $("profExportLabel").textContent = many ? "Export matrix" : "Export comparison";
  $("profAdd").style.display = profSlots.length < 8 ? "inline" : "none";
}

async function collectProfCmp() {
  {
    const kind = $("cmpKind").value;
    const kindLabel = kind === "profile" ? "Profile" : "Permission set";
    const [aAuth, bAuth] = await Promise.all([
      sessionForHost($("profOrgA").value), sessionForHost($("profOrgB").value)]);
    const idA = $("profA").value, idB = $("profB").value;
    const nameA = $("profA").selectedOptions[0]?.textContent || "A";
    const nameB = $("profB").selectedOptions[0]?.textContent || "B";
    const sameOrg = aAuth === bAuth;
    if (!idA || !idB) throw new Error("No " + kindLabel.toLowerCase() + "s loaded.");
    if (sameOrg && idA === idB) throw new Error("Pick two different " + kindLabel.toLowerCase() + "s.");
    const colA = sameOrg ? nameA : nameA + " @ " + hostOf(aAuth);
    const colB = sameOrg ? nameB : nameB + " @ " + hostOf(bAuth);
    // each header links into the org that side belongs to, which need not be the connected one
    const linkFor = (side, sideAuth, id) => {
      const pid = $("prof" + side).selectedOptions[0]?.dataset?.pid;
      return kind === "profile"
        ? (pid ? setupUrl.profile(pid, sideAuth) : "")
        : setupUrl.permSet(id, sideAuth);
    };
    const urlA = linkFor("A", aAuth, idA), urlB = linkFor("B", bAuth, idB);

    // object CRUD
    setStatus("Comparing object permissions…", "busy");
    const OPKEYS = [["PermissionsRead","Read"],["PermissionsCreate","Create"],["PermissionsEdit","Edit"],["PermissionsDelete","Delete"],["PermissionsViewAllRecords","View All"],["PermissionsModifyAllRecords","Modify All"]];
    const opQ = (id) => "SELECT SobjectType, " + OPKEYS.map(k => k[0]).join(", ") + " FROM ObjectPermissions WHERE ParentId = '" + id + "' ORDER BY SobjectType";
    const [opA, opB] = await Promise.all([stdQueryFor(aAuth, opQ(idA)), stdQueryFor(bAuth, opQ(idB))]);
    const oa = new Map(opA.map(r => [r.SobjectType, r])), ob = new Map(opB.map(r => [r.SobjectType, r]));
    const diffOnly = $("profDiffOnly").checked;
    const objRows = [["Object", "Permission", colA, colB, "Result"]];
    for (const obj of [...new Set([...oa.keys(), ...ob.keys()])].sort()) {
      const a = oa.get(obj), b = ob.get(obj);
      for (const [k, label] of OPKEYS) {
        const va = a ? !!a[k] : false, vb = b ? !!b[k] : false;
        if (diffOnly && va === vb) continue;
        objRows.push([obj, label, va ? "Yes" : "No", vb ? "Yes" : "No", va === vb ? "Same" : "Differs"]);
      }
    }

    // field-level security
    setStatus("Comparing field permissions…", "busy");
    const fpQ = (id) => "SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '" + id + "' ORDER BY Field";
    const [fpA, fpB] = await Promise.all([stdQueryFor(aAuth, fpQ(idA)), stdQueryFor(bAuth, fpQ(idB))]);
    const acc = (r) => r.PermissionsEdit ? "Edit" : r.PermissionsRead ? "Read" : "None";
    const fa = new Map(fpA.map(r => [r.Field, acc(r)])), fb = new Map(fpB.map(r => [r.Field, acc(r)]));
    const flsRows = [["Field", colA, colB, "Result"]];
    for (const f of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
      const va = fa.get(f) || "None", vb = fb.get(f) || "None";
      if (diffOnly && va === vb) continue;
      flsRows.push([f, va, vb, va === vb ? "Same" : "Differs"]);
    }

    // system permissions
    setStatus("Comparing system permissions…", "busy");
    const sysRows = [["System Permission", colA, colB, "Result"]];
    try {
      const sysQ = (id) => "SELECT FIELDS(STANDARD) FROM PermissionSet WHERE Id = '" + id + "' LIMIT 1";
      const [ra, rb] = await Promise.all([
        apiFor(aAuth, "/query/?q=" + encodeURIComponent(sysQ(idA))),
        apiFor(bAuth, "/query/?q=" + encodeURIComponent(sysQ(idB))),
      ]);
      const a = (ra.records || [])[0] || {}, b = (rb.records || [])[0] || {};
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => k.indexOf("Permissions") === 0).sort();
      for (const k of keys) {
        const va = !!a[k], vb = !!b[k];
        if (diffOnly && va === vb) continue;
        sysRows.push([k.replace(/^Permissions/, ""), va ? "Yes" : "No", vb ? "Yes" : "No", va === vb ? "Same" : "Differs"]);
      }
    } catch (err) { sysRows.push(["(unavailable: " + err.message + ")", "", "", ""]); }

    // Apex / VF / custom permission / app access
    setStatus("Comparing Apex/VF/custom-permission access…", "busy");
    const seaRows = [["Access Type", "Component", colA, colB, "Result"]];
    try {
      const seaQ = (id) => "SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = '" + id + "' AND SetupEntityType IN ('ApexClass','ApexPage','CustomPermission','ConnectedApplication','TabSet')";
      const [sa, sb] = await Promise.all([stdQueryFor(aAuth, seaQ(idA)), stdQueryFor(bAuth, seaQ(idB))]);
      const resolve = async (a, recs) => {
        const names = new Map();
        const resolvers = [
          ["ApexClass", (i) => "SELECT Id, Name FROM ApexClass WHERE Id IN (" + i + ")"],
          ["ApexPage", (i) => "SELECT Id, Name FROM ApexPage WHERE Id IN (" + i + ")"],
          ["CustomPermission", (i) => "SELECT Id, DeveloperName FROM CustomPermission WHERE Id IN (" + i + ")"],
        ];
        for (const [type, q] of resolvers) {
          const ids = recs.filter(r => r.SetupEntityType === type).map(r => "'" + r.SetupEntityId + "'");
          for (let i = 0; i < ids.length; i += 200) {
            try {
              for (const r of await stdQueryFor(a, q(ids.slice(i, i + 200).join(",")))) names.set(r.Id, r.Name || r.DeveloperName);
            } catch (err) { console.warn(type + " resolve failed:", err); }
          }
        }
        return new Set(recs.map(r => r.SetupEntityType + "|" + (names.get(r.SetupEntityId) || r.SetupEntityId)));
      };
      const [setA, setB] = await Promise.all([resolve(aAuth, sa), resolve(bAuth, sb)]);
      for (const k of [...new Set([...setA, ...setB])].sort()) {
        const inA = setA.has(k), inB = setB.has(k);
        if (diffOnly && inA === inB) continue;
        const parts = k.split("|");
        seaRows.push([parts[0], parts[1], inA ? "Yes" : "No", inB ? "Yes" : "No", inA === inB ? "Same" : "Differs"]);
      }
    } catch (err) { seaRows.push(["(unavailable: " + err.message + ")", "", "", "", ""]); }

    // tab visibility
    setStatus("Comparing tab visibility…", "busy");
    const tabRows = [["Tab", colA, colB, "Result"]];
    try {
      const tQ = (id) => "SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = '" + id + "'";
      const [ta, tb] = await Promise.all([stdQueryFor(aAuth, tQ(idA)), stdQueryFor(bAuth, tQ(idB))]);
      const va = new Map(ta.map(r => [r.Name, r.Visibility])), vb = new Map(tb.map(r => [r.Name, r.Visibility]));
      for (const t of [...new Set([...va.keys(), ...vb.keys()])].sort()) {
        const x = va.get(t) || "Hidden", y = vb.get(t) || "Hidden";
        if (diffOnly && x === y) continue;
        tabRows.push([t, x, y, x === y ? "Same" : "Differs"]);
      }
    } catch (err) { tabRows.push(["(unavailable: " + err.message + ")", "", "", ""]); }

    setStatus("");
    return {
      kind, kindLabel, nameA, nameB, colA, colB, sameOrg, diffOnly, urlA, urlB,
      sections: [
        { title: "Object CRUD", area: "Object CRUD", rows: objRows, itemCols: 2 },
        { title: "Field Security", area: "Field security", rows: flsRows, itemCols: 1 },
        { title: "System Permissions", area: "System permission", rows: sysRows, itemCols: 1 },
        { title: "Apex-VF-Custom Access", area: "Apex / VF / custom", rows: seaRows, itemCols: 2 },
        { title: "Tab Visibility", area: "Tab visibility", rows: tabRows, itemCols: 1 },
      ],
    };
  }
}

// One flat table on screen: Area · Item · A · B · Result
function renderProfCmpCard(res) {
  const flat = [];
  for (const s of res.sections) {
    for (const r of s.rows.slice(1)) {
      const item = s.itemCols === 2 ? `${r[0]} · ${r[1]}` : r[0];
      const rest = r.slice(s.itemCols);
      flat.push([s.area, item, rest[0] ?? "", rest[1] ?? "", rest[2] ?? (rest[0] === rest[1] ? "Same" : "Differs")]);
    }
  }
  $("pmxResult").style.display = "none";
  $("profResTitle").textContent = `${res.colA}  vs  ${res.colB}`;
  const head = (el, text, url) => {
    const cell = $(el);
    cell.innerHTML = url
      ? `<a href="${escHtml(url)}" target="_blank" rel="noopener" title="Open in Setup">${escHtml(text)}</a>`
      : escHtml(text);
  };
  head("profResColA", res.colA, res.urlA);
  head("profResColB", res.colB, res.urlB);
  $("profResNote").textContent = flat.length
    ? (res.diffOnly ? "Differences only. " : "All permissions from both sides. ")
      + (res.sameOrg ? "Same org." : "Across two orgs.")
      + " Export for the full workbook, including what REST cannot compare."
    : "No differences found between these two, they grant the same access everywhere Org Lens can see.";
  const counts = res.sections.map(s => `<span class="r">${s.rows.length - 1} ${escHtml(s.title.toLowerCase())}</span>`).join("");
  const differs = flat.filter(r => r[4] === "Differs").length;
  $("profResSummary").innerHTML = counts + `<span class="n">${differs} differ</span>`;
  $("profResList").innerHTML = flat.slice(0, 600).map(r =>
    `<tr><td>${escHtml(r[0])}</td><td>${escHtml(r[1])}</td><td>${escHtml(r[2])}</td><td>${escHtml(r[3])}</td>` +
    `<td class="${r[4] === "Differs" ? "accNone" : "accEdit"}">${escHtml(r[4])}</td></tr>`).join("")
    || `<tr><td colspan="5" style="color:var(--faint);">Nothing to show: the two are identical.</td></tr>`;
  if (flat.length > 600) $("profResNote").textContent += ` Showing the first 600 of ${flat.length} rows.`;
  flashBox("profResult");
}

async function showProfCmp() {
  const btn = $("profShowBtn");
  btn.disabled = true;
  try { renderProfCmpCard(await collectProfCmp()); }
  catch (err) { setStatus("Compare failed: " + err.message, "err"); }
  finally { btn.disabled = false; }
}

async function runProfCmp() {
  const btn = $("profCmpBtn");
  btn.disabled = true;
  try {
    const res = await collectProfCmp();
    renderProfCmpCard(res);
    const { kindLabel, colA, colB, sameOrg, diffOnly, sections, kind, nameA, nameB } = res;
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, [["Comparing", kindLabel], ["Side A", colA], ["Side B", colB],
      ["Mode", sameOrg ? "same org" : "across orgs"],
      ["Scope", diffOnly ? "differences only" : "all permissions from both sides"],
      ["Generated", today()]], "About");
    for (const s of sections) {
      const rows = s.rows.length > 1 ? s.rows : [...s.rows, [`(no ${s.title.toLowerCase()} rows)`, ...s.rows[0].slice(1).map(() => "")]];
      sheetFromRows(wb, rows, s.title);
    }
    sheetFromRows(wb, [["Not comparable via REST API (use sf CLI + Metadata API)"], ["Record type visibility"], ["Page layout assignments"], ["Login hours / IP ranges"]], "Not Covered");
    const safe = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 28);
    XLSX.writeFile(wb, kind + "_" + safe(nameA) + "_vs_" + safe(nameB) + "_" + today() + ".xlsx");
    const total = sections.reduce((n, s) => n + s.rows.length - 1, 0);
    setStatus(`Exported, ${total} rows across ${sections.length} sheets.`, "ok");
  } catch (err) {
    setStatus("Compare failed: " + err.message, "err");
  } finally { btn.disabled = false; }
}

// ---------- user effective access ----------
async function uaFind() {
  const q = $("uaSearch").value.trim().replace(/'/g, "");
  if (q.length < 2) return setStatus("Type at least 2 characters.", "err");
  try {
    setStatus("Searching users…", "busy");
    const users = await stdQuery(
      `SELECT Id, Name, Username, Profile.Name FROM User ` +
      `WHERE IsActive = true AND UserType = 'Standard' AND (Name LIKE '%${q}%' OR Username LIKE '%${q}%') ORDER BY Name LIMIT 25`);
    if (!users.length) { $("uaResults").style.display = "none"; return setStatus("No active users match.", "err"); }
    $("uaUser").innerHTML = users.map(u =>
      `<option value="${escHtml(u.Id)}">${escHtml(u.Name)} · ${escHtml(u.Username)} (${escHtml(u.Profile?.Name || "no profile")})</option>`).join("");
    $("uaResults").style.display = "block";
    setStatus(`${users.length} user(s) found.`, "ok");
  } catch (e) { setStatus(`User search failed: ${e.message}`, "err"); }
}

async function collectUserAccess() {
  {
    const uid = $("uaUser").value;
    const uname = $("uaUser").selectedOptions[0]?.textContent.split(" · ")[0] || "user";
    setStatus("Collecting permission sources…", "busy");
    const psa = await stdQuery(
      `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name ` +
      `FROM PermissionSetAssignment WHERE AssigneeId = '${uid}'`);
    if (!psa.length) throw new Error("No permission sources found for this user.");
    const srcName = (r) => r.PermissionSet?.IsOwnedByProfile
      ? `Profile: ${r.PermissionSet?.Profile?.Name || r.PermissionSet?.Label}`
      : r.PermissionSet?.Label || r.PermissionSetId;
    const labelById = new Map(psa.map(r => [r.PermissionSetId, srcName(r)]));
    const psIds = [...labelById.keys()];
    const inClause = psIds.map(i => `'${i}'`).join(",");

    const srcRows = [["Permission Source","Type"]];
    for (const r of psa) srcRows.push([srcName(r), r.PermissionSet?.IsOwnedByProfile ? "Profile" : "Permission Set"]);

    // effective object CRUD (union) with sources
    setStatus("Merging object permissions…", "busy");
    const op = await stdQuery(
      `SELECT ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords ` +
      `FROM ObjectPermissions WHERE ParentId IN (${inClause}) ORDER BY SobjectType`);
    const OPK = [["PermissionsRead","Read"],["PermissionsCreate","Create"],["PermissionsEdit","Edit"],["PermissionsDelete","Delete"],["PermissionsViewAllRecords","View All"],["PermissionsModifyAllRecords","Modify All"]];
    const objAgg = new Map();
    for (const r of op) {
      const o = objAgg.get(r.SobjectType) || {};
      for (const [k] of OPK) if (r[k]) (o[k] ||= []).push(labelById.get(r.ParentId) || "?");
      objAgg.set(r.SobjectType, o);
    }
    const objRows = [["Object", ...OPK.map(([, l]) => l), "Granted via"]];
    for (const [obj, o] of [...objAgg.entries()].sort()) {
      const via = [...new Set(OPK.flatMap(([k]) => o[k] || []))].join("; ");
      objRows.push([obj, ...OPK.map(([k]) => o[k] ? "Yes" : ""), via]);
    }

    // effective FLS (union: Edit beats Read)
    setStatus("Merging field permissions…", "busy");
    const fp = await stdQuery(
      `SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (${inClause}) ORDER BY Field`);
    const flsAgg = new Map();
    for (const r of fp) {
      const cur = flsAgg.get(r.Field) || { lvl: "None", via: new Set() };
      const lvl = r.PermissionsEdit ? "Edit" : r.PermissionsRead ? "Read" : "None";
      if (lvl !== "None") cur.via.add(labelById.get(r.ParentId) || "?");
      if (lvl === "Edit" || (lvl === "Read" && cur.lvl === "None")) cur.lvl = lvl === "Edit" ? "Edit" : (cur.lvl === "Edit" ? "Edit" : "Read");
      flsAgg.set(r.Field, cur);
    }
    const flsRows = [["Field","Effective Access","Granted via"]];
    for (const [f, v] of [...flsAgg.entries()].sort()) flsRows.push([f, v.lvl, [...v.via].join("; ")]);

    // effective system permissions (OR across sources)
    setStatus("Merging system permissions…", "busy");
    const sysRows = [["System Permission","Granted via"]];
    try {
      const psRecs = await stdQuery(`SELECT FIELDS(STANDARD) FROM PermissionSet WHERE Id IN (${inClause}) LIMIT 200`);
      const grant = new Map();
      for (const r of psRecs) {
        for (const [k, v] of Object.entries(r)) {
          if (k.startsWith("Permissions") && v === true) (grant.get(k) || grant.set(k, []).get(k)).push(labelById.get(r.Id) || "?");
        }
      }
      for (const [k, via] of [...grant.entries()].sort()) sysRows.push([k.replace(/^Permissions/, ""), [...new Set(via)].join("; ")]);
    } catch (e) { sysRows.push([`(unavailable: ${e.message})`, ""]); }

    // Apex/VF/custom permission access
    setStatus("Merging Apex/VF access…", "busy");
    const seaRows = [["Access Type","Component","Granted via"]];
    try {
      const sea = await stdQuery(
        `SELECT ParentId, SetupEntityId, SetupEntityType FROM SetupEntityAccess ` +
        `WHERE ParentId IN (${inClause}) AND SetupEntityType IN ('ApexClass','ApexPage','CustomPermission')`);
      const ids = (type) => sea.filter(r => r.SetupEntityType === type).map(r => `'${r.SetupEntityId}'`);
      const nameById = new Map();
      for (const [type, soql] of [
        ["ApexClass", (i) => `SELECT Id, Name FROM ApexClass WHERE Id IN (${i})`],
        ["ApexPage", (i) => `SELECT Id, Name FROM ApexPage WHERE Id IN (${i})`],
        ["CustomPermission", (i) => `SELECT Id, DeveloperName FROM CustomPermission WHERE Id IN (${i})`],
      ]) {
        const t = ids(type);
        for (let i = 0; i < t.length; i += 200) {
          try { for (const r of await stdQuery(soql(t.slice(i, i + 200).join(",")))) nameById.set(r.Id, r.Name || r.DeveloperName); }
          catch (e) { console.warn(`${type} resolve failed:`, e); }
        }
      }
      const agg = new Map();
      for (const r of sea) {
        const k = `${r.SetupEntityType}|${nameById.get(r.SetupEntityId) || r.SetupEntityId}`;
        (agg.get(k) || agg.set(k, []).get(k)).push(labelById.get(r.ParentId) || "?");
      }
      for (const [k, via] of [...agg.entries()].sort()) {
        const [t, n] = k.split("|");
        seaRows.push([t, n, [...new Set(via)].join("; ")]);
      }
    } catch (e) { seaRows.push([`(unavailable: ${e.message})`, "", ""]); }

    setStatus("");
    return { uname, sources: psa.length, srcRows, objRows, flsRows, sysRows, seaRows, OPK };
  }
}

let uaFlat = [];
function renderUserAccessCard(res) {
  uaFlat = [];
  for (const r of res.srcRows.slice(1)) uaFlat.push(["Source", r[0], r[1], ""]);
  // object rows: [obj, ...crud flags, via]
  for (const r of res.objRows.slice(1)) {
    const flags = res.OPK.map(([, label], i) => r[i + 1] === "Yes" ? label : null).filter(Boolean);
    uaFlat.push(["Object", r[0], flags.join(", ") || "—", r[r.length - 1] || ""]);
  }
  for (const r of res.flsRows.slice(1)) uaFlat.push(["Field", r[0], r[1], r[2] || ""]);
  for (const r of res.sysRows.slice(1)) uaFlat.push(["System", r[0], "Granted", r[1] || ""]);
  for (const r of res.seaRows.slice(1)) uaFlat.push([r[0] || "Access", r[1], "Granted", r[2] || ""]);

  $("uaResTitle").textContent = res.uname;
  $("uaResNote").textContent =
    `Merged from ${res.sources} permission source${res.sources === 1 ? "" : "s"} (profile + permission sets). ` +
    `“Granted via” names the source of each right, the answer to “why can this user do that?”.`;
  const n = (a) => uaFlat.filter(r => r[0] === a).length;
  $("uaResSummary").innerHTML =
    `<span class="r">${n("Source")} sources</span>` +
    `<span class="r">${n("Object")} objects</span>` +
    `<span class="e">${n("Field")} fields</span>` +
    `<span class="r">${n("System")} system permissions</span>`;
  $("uaResFilter").value = "";
  renderUserAccessRows();
  flashBox("uaResult");
}

function renderUserAccessRows() {
  const q = $("uaResFilter").value.trim().toLowerCase();
  const rows = q ? uaFlat.filter(r => r.join(" ").toLowerCase().includes(q)) : uaFlat;
  $("uaResList").innerHTML = rows.slice(0, 600).map(r =>
    `<tr><td>${escHtml(r[0])}</td><td>${hl(r[1], q)}</td>` +
    `<td class="${r[2] === "—" ? "accNone" : "accEdit"}">${escHtml(r[2])}</td>` +
    `<td>${hl(r[3], q)}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:var(--faint);">Nothing matches.</td></tr>`;
}

async function uaShow() {
  const btn = $("uaShowBtn");
  btn.disabled = true;
  try { renderUserAccessCard(await collectUserAccess()); }
  catch (e) { setStatus(`User access failed: ${e.message}`, "err"); }
  finally { btn.disabled = false; }
}

async function uaExport() {
  const btn = $("uaExportBtn");
  btn.disabled = true;
  try {
    const res = await collectUserAccess();
    renderUserAccessCard(res);
    const { uname, srcRows, objRows, flsRows, sysRows, seaRows, sources } = res;
    const wb = XLSX.utils.book_new();
    sheetFromRows(wb, srcRows, "Permission Sources");
    sheetFromRows(wb, objRows.length > 1 ? objRows : [...objRows, ["(none)","","","","","","",""]], "Object Access");
    sheetFromRows(wb, flsRows.length > 1 ? flsRows : [...flsRows, ["(none)","",""]], "Field Access");
    sheetFromRows(wb, sysRows.length > 1 ? sysRows : [...sysRows, ["(none)",""]], "System Permissions");
    sheetFromRows(wb, seaRows.length > 1 ? seaRows : [...seaRows, ["(none)","",""]], "Apex-VF-Custom Access");
    const safe = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 30);
    XLSX.writeFile(wb, `user_access_${safe(uname)}_${today()}.xlsx`);
    setStatus(`Exported, effective access for ${uname} across ${sources} permission source(s).`, "ok");
  } catch (e) {
    setStatus(`User access export failed: ${e.message}`, "err");
  } finally { btn.disabled = false; }
}


// ---------- init ----------
$("connectBtn").addEventListener("click", connect);
$("exportBtn").addEventListener("click", exportSchema);
$("soqlRunBtn").addEventListener("click", soqlRun);
$("jobsShowBtn").addEventListener("click", jobsShow);
$("jobsExportBtn").addEventListener("click", jobsExport);
$("soqlSaveBtn").addEventListener("click", saveCurrentQuery);
$("soqlDelBtn").addEventListener("click", deleteSavedQuery);
$("soqlSaved").addEventListener("change", applySavedQuery);
$("auditShowBtn").addEventListener("click", auditShow);
$("auditExportBtn").addEventListener("click", auditExport);
$("testsShowBtn").addEventListener("click", testsShow);
$("testsResList").addEventListener("click", (e) => {
  const a = e.target.closest("[data-cov]");
  if (a) showCoveringTests(a.dataset.cov);
});
$("testsExportBtn").addEventListener("click", testsExport);
$("countsShowBtn").addEventListener("click", countsShow);
$("countsExportBtn").addEventListener("click", countsExport);
document.querySelectorAll(".auditPick").forEach(a => a.addEventListener("click", () => {
  const d = new Date();
  d.setDate(d.getDate() - Number(a.dataset.days));
  $("auditSince").value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  setStatus(`Since ${$("auditSince").value}.`);
}));
$("codeSearchBtn").addEventListener("click", codeSearch);
$("codeListBtn").addEventListener("click", codeList);
$("codeListFilter").addEventListener("input", renderCodeList);
$("codeListFilter").addEventListener("search", renderCodeList);
$("codeListBody").addEventListener("click", (e) => {
  const row = e.target.closest("[data-file]");
  if (row) openCodeFile(row.dataset.file);
});
$("erdDrawBtn").addEventListener("click", erdDraw);
$("erdRelayoutBtn").addEventListener("click", erdRelayout);
$("erdFitBtn").addEventListener("click", erdFit);
$("erdSvgBtn").addEventListener("click", erdExportSvg);
$("erdPngBtn").addEventListener("click", erdExportPng);
$("erdPdfBtn").addEventListener("click", erdExportPdf);
$("erdSearch").addEventListener("input", renderErdList);
$("erdSearch").addEventListener("search", renderErdList);
$("erdList").addEventListener("change", (e) => {
  const n = e.target?.dataset?.eobj;
  if (!n) return;
  e.target.checked ? erdSel.add(n) : erdSel.delete(n);
  $("erdCount").textContent = erdSel.size + " selected";
});
$("erdClear").addEventListener("click", () => { erdSel.clear(); renderErdList(); });
$("erdDark").addEventListener("change", () => { if (erdModel) renderErdKeepView(); });
$("erdHops").addEventListener("change", () => { if (erdModel) renderErdKeepView(); });
$("erdUndoBtn").addEventListener("click", erdUndoMove);
$("erdFind").addEventListener("input", erdFindHighlight);
$("erdFind").addEventListener("search", erdFindHighlight);
document.addEventListener("keydown", (e) => {
  // only while the diagram is the panel on screen, so Ctrl+Z still works in text fields
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
  if ($("panelErd").style.display === "none" || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
  e.preventDefault();
  erdUndoMove();
});
$("erdDetail").addEventListener("change", () => { if (erdModel) erdDraw(); });
wireErdCanvas();
$("codeExportBtn").addEventListener("click", codeExport);
$("codeTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b || !codeBundleFiles.length) return;
  codeBundleIdx = Number(b.dataset.tab);
  renderCodeBundle(codeBundleOwner || { bundle: "", type: "" });
});
$("codeTerm").addEventListener("keydown", (e) => { if (e.key === "Enter") codeSearch(); });
$("codeResList").addEventListener("click", (e) => {
  const row = e.target.closest("[data-hit]");
  if (row) openCodeHit(row.dataset.hit);
});
$("codeHitClose").addEventListener("click", () => { $("codeHitBox").style.display = "none"; });
$("soqlExportBtn").addEventListener("click", soqlExport);
wireSoqlAutocomplete();
$("soqlText").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); soqlRun(); }
});
document.querySelectorAll(".soqlEg").forEach(a => a.addEventListener("click", () => {
  $("soqlText").value = a.dataset.q;
  $("soqlText").focus();
}));
$("packageBtn").addEventListener("click", exportPackage);
$("mdAllBtn").addEventListener("click", exportAllMetadata);
document.querySelectorAll(".sincePick").forEach(a => a.addEventListener("click", () => {
  const d = new Date();
  d.setDate(d.getDate() - Number(a.dataset.days));
  // local date, not UTC, so "7 days ago" matches the user's calendar
  const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $("sinceDate").value = iso;
  setStatus(`Since ${iso}.`);
}));
$("logoutBtn").addEventListener("click", disconnect);
$("orgRefresh").addEventListener("click", loadOrgs);
$("cmpShowBtn").addEventListener("click", cmpShow);
$("cmpExportBtn").addEventListener("click", cmpExport);
$("mxRefresh").addEventListener("click", async () => { mxSlots = []; await loadMxOrgs(); });
$("mxFilter").addEventListener("input", renderMatrix);
$("mxFilter").addEventListener("search", renderMatrix);
$("orgDiffOnly").addEventListener("change", () => { if (mxRows.length) renderMatrix(); });
$("mxAdd").addEventListener("click", () => {
  const mine = auth ? apiHostOf(auth) : "";
  const next = mxAllOrgs.find(o => o.host !== mine && !mxSlots.includes(o.host));
  if (!next) return;
  mxSlots.push(next.host);
  renderMxSlots();
});
$("mxSlots").addEventListener("change", (e) => {
  const sel = e.target.closest("[data-slot]");
  if (sel) {
    const i = Number(sel.dataset.slot);
    mxSlots[i] = sel.value;
    renderMxSlots();
  }
});
$("mxSlots").addEventListener("click", (e) => {
  const drop = e.target.closest("[data-drop]");
  if (!drop) return;
  mxSlots.splice(Number(drop.dataset.drop), 1);
  renderMxSlots();
});
$("limitsToggle").addEventListener("click", toggleLimits);
$("limitsFilter").addEventListener("input", renderLimits);
$("limitsFilter").addEventListener("search", renderLimits);
$("shShowBtn").addEventListener("click", sharingShow);
$("shRowsBtn").addEventListener("click", countShareRows);
$("shApexBtn").addEventListener("click", findApexSharing);
$("shShareSearch").addEventListener("input", renderShareObjectPicker);
$("shShareSearch").addEventListener("search", renderShareObjectPicker);
$("shShareList").addEventListener("change", (e) => {
  const n = e.target?.dataset?.shobj;
  if (!n) return;
  e.target.checked ? shShareSel.add(n) : shShareSel.delete(n);
  $("shShareCount").textContent = `${shShareSel.size} selected`;
});
$("shShareClear").addEventListener("click", () => { shShareSel.clear(); renderShareObjectPicker(); });
$("shShareFromRules").addEventListener("click", () => {
  shShareSel.clear();
  for (const o of shOwd.filter(x => x.rules > 0).slice(0, 10)) shShareSel.add(o.api);
  renderShareObjectPicker();
  setStatus(shShareSel.size ? `${shShareSel.size} objects with sharing rules selected.` : "No object has sharing rules.", shShareSel.size ? "ok" : "err");
});
$("shExportBtn").addEventListener("click", sharingExport);
$("shFilter").addEventListener("input", () => { if (shOwd.length) renderOwdList(); });
$("shFilter").addEventListener("search", () => { if (shOwd.length) renderOwdList(); });
$("shOpenOnly").addEventListener("change", () => { if (shOwd.length) renderOwdList(); });
$("secShowBtn").addEventListener("click", securityShow);
$("secExportBtn").addEventListener("click", securityExport);
$("secFilter").addEventListener("input", renderSecList);
$("secFilter").addEventListener("search", renderSecList);
$("docBuildBtn").addEventListener("click", () => docBuild(false));
$("docWordBtn").addEventListener("click", () => docBuild(true));
$("docSearch").addEventListener("input", renderDocList);
$("docSearch").addEventListener("search", renderDocList);
$("docList").addEventListener("change", (e) => {
  const n = e.target?.dataset?.docobj;
  if (!n) return;
  e.target.checked ? docSel.add(n) : docSel.delete(n);
  $("docCount").textContent = `${docSel.size} selected`;
});
$("docClear").addEventListener("click", () => { docSel.clear(); renderDocList(); });
$("docFromErd").addEventListener("click", () => {
  if (!erdModel) return setStatus("Draw a diagram first, then its objects can be reused here.", "err");
  docSel.clear();
  for (const n of erdModel.nodes.slice(0, 25)) docSel.add(n.id);
  renderDocList();
  setStatus(`${docSel.size} objects taken from the diagram.`, "ok");
});
["docTitle", "docClient", "docAuthor", "docNote"].forEach(id => $(id).addEventListener("change", saveDocBrand));
$("permsBtn").addEventListener("click", runPerms);
$("permsShowBtn").addEventListener("click", showPerms);
$("permSearch").addEventListener("input", renderPermList);
$("permList").addEventListener("change", (e) => {
  const n = e.target?.dataset?.pobj;
  if (!n) return;
  e.target.checked ? permSel.add(n) : permSel.delete(n);
  $("permCount").textContent = `${permSel.size} selected`;
});
$("permClear").addEventListener("click", () => { permSel.clear(); renderPermList(); });
$("autoBtn").addEventListener("click", runAuto);
$("autoShowBtn").addEventListener("click", showAuto);
$("autoSearch").addEventListener("input", renderAutoList);
$("autoList").addEventListener("change", (e) => {
  const n = e.target?.dataset?.aobj;
  if (!n) return;
  e.target.checked ? autoSel.add(n) : autoSel.delete(n);
  $("autoCount").textContent = autoSel.size ? autoSel.size + " selected" : "0 selected (whole org)";
});
$("autoClear").addEventListener("click", () => { autoSel.clear(); renderAutoList(); });
$("depsBtn").addEventListener("click", runDeps);
$("usageBtn").addEventListener("click", runUsage);
$("usageShowBtn").addEventListener("click", showUsage);
$("unusedBtn").addEventListener("click", runUnused);

$("usageSearch").addEventListener("input", renderUsageList);
$("usageSearch").addEventListener("search", renderUsageList);
$("usageList").addEventListener("change", (e) => {
  const n = e.target?.dataset?.uobj;
  if (!n) return;
  e.target.checked ? usageSel.add(n) : usageSel.delete(n);
  $("usageCount").textContent = usageSel.size + " selected";
});
$("usageClear").addEventListener("click", () => { usageSel.clear(); renderUsageList(); });
$("depsShowBtn").addEventListener("click", showDeps);
$("depType").addEventListener("change", loadDepNames);
$("depObj").addEventListener("change", loadDepNames);
$("depObjFilter").addEventListener("input", () => { renderDepObjOptions(); loadDepNames(); });
$("depObjFilter").addEventListener("search", () => { renderDepObjOptions(); loadDepNames(); });
$("depReload").addEventListener("click", loadDepNames);
$("depFilter").addEventListener("input", renderDepItems);
$("depFilter").addEventListener("search", renderDepItems);
$("packageShowBtn").addEventListener("click", showPackage);
$("snapshotBtn").addEventListener("click", downloadSnapshot);
$("profCmpBtn").addEventListener("click", () => profSlots.length > 2 ? profMatrixExport() : runProfCmp());
$("profShowBtn").addEventListener("click", () => profSlots.length > 2 ? profMatrixShow() : showProfCmp());
$("cmpKind").addEventListener("change", () => initProfCmp(true));
$("profSlots").addEventListener("change", (e) => {
  const id = e.target?.id || "";
  if (id.indexOf("profOrg") === 0) fillContainerSelect(id.slice(7));
});
$("profSlots").addEventListener("click", (e) => {
  const drop = e.target.closest("[data-profdrop]");
  if (!drop) return;
  profSlots = profSlots.filter(s => s !== drop.dataset.profdrop);
  renderProfSlots();
});
$("profAdd").addEventListener("click", async () => {
  const next = PROF_LETTERS[profSlots.length];
  if (!next) return;
  profSlots.push(next);
  renderProfSlots();
  await fillContainerSelect(next);
});
$("profReload").addEventListener("click", () => initProfCmp(true));
$("auditBtn").addEventListener("click", runFullAudit);
$("uaFindBtn").addEventListener("click", uaFind);
$("uaSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") uaFind(); });
$("uaExportBtn").addEventListener("click", uaExport);
$("uaShowBtn").addEventListener("click", uaShow);
$("uaResFilter").addEventListener("input", renderUserAccessRows);
$("uaResFilter").addEventListener("search", renderUserAccessRows);
$("bSearch").addEventListener("input", renderBrowserObjects);
$("bFieldSearch").addEventListener("input", renderBrowserFields);
$("bObjList").addEventListener("click", (e) => {
  const row = e.target.closest(".objrow");
  if (row?.dataset.obj) openBrowserObject(row.dataset.obj);
});
$("bBack").addEventListener("click", () => {
  $("bFieldView").style.display = "none";
  $("bFLSInline").style.display = "none";
  $("bRTInline").style.display = "none";
  $("bObjView").style.display = "block";
});
$("bRTBtn").addEventListener("click", openRecordTypeAccess);
$("bRefsBtn").addEventListener("click", showFieldReferences);
$("bFieldSetupBtn").addEventListener("click", openFieldInSetup);
for (const id of ["secElevList", "secUnusedList"]) {
  $(id).addEventListener("click", (e) => {
    const row = e.target.closest("[data-url]");
    if (row?.dataset.url) window.open(row.dataset.url, "_blank", "noopener");
  });
}
$("bRTList").addEventListener("click", (e) => {
  const row = e.target.closest("[data-url]");
  if (row?.dataset.url) window.open(row.dataset.url, "_blank", "noopener");
});
$("bFLSList").addEventListener("click", (e) => {
  const row = e.target.closest("[data-url]");
  if (row?.dataset.url) window.open(row.dataset.url, "_blank", "noopener");
});
$("bFieldList").addEventListener("click", (e) => {
  const pk = e.target.closest("[data-pk]");
  if (pk?.dataset.pk) { e.stopPropagation(); openPicklistModal(pk.dataset.pk); return; }
  const row = e.target.closest("[data-field]");
  if (row?.dataset.field) openFieldFLS(row.dataset.field);
});
$("covClose").addEventListener("click", () => $("covOverlay").classList.remove("open"));
$("covOverlay").addEventListener("click", (e) => { if (e.target === $("covOverlay")) $("covOverlay").classList.remove("open"); });
$("pkClose").addEventListener("click", () => $("pkOverlay").classList.remove("open"));
$("pkOverlay").addEventListener("click", (e) => { if (e.target === $("pkOverlay")) $("pkOverlay").classList.remove("open"); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("pkOverlay").classList.remove("open"); $("covOverlay").classList.remove("open"); }
});
document.querySelectorAll(".navitem").forEach(b =>
  b.addEventListener("click", () => showPanel(b.dataset.panel)));
$("pickObjects").addEventListener("change", togglePicker);
$("pickerSearch").addEventListener("input", renderPicker);
$("customOnly").addEventListener("change", () => { if ($("pickObjects").checked) renderPicker(); });
$("pickerList").addEventListener("change", (e) => {
  const name = e.target?.dataset?.obj;
  if (!name) return;
  e.target.checked ? selectedObjs.add(name) : selectedObjs.delete(name);
  $("pickCount").textContent = `${selectedObjs.size} selected`;
});
$("pickAll").addEventListener("click", () => { shownObjects().slice(0, 400).forEach(s => selectedObjs.add(s.name)); renderPicker(); });
$("pickNone").addEventListener("click", () => { selectedObjs.clear(); renderPicker(); });

$("bSearch").addEventListener("search", renderBrowserObjects);
$("bFieldSearch").addEventListener("search", renderBrowserFields);
$("pickerSearch").addEventListener("search", renderPicker);
$("permSearch").addEventListener("search", renderPermList);
$("autoSearch").addEventListener("search", renderAutoList);
installResultChrome();
refreshSavedQueries();
showPanelHint();
$("verStamp").textContent = APP_VERSION;

// restore a session that survived a page reload, else offer the org list
const savedAuth = JSON.parse(sessionStorage.getItem("sf_auth") || "null");
if (savedAuth?.accessToken && savedAuth?.instanceUrl) {
  auth = savedAuth;
  showConnected().then(() => {
    const p = sessionStorage.getItem("sf_panel");
    if (p && PANELS.includes(p)) showPanel(p);
  });
} else {
  loadOrgs({ autoConnect: true });
}
