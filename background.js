// Org Lens — background service worker.
// Two jobs: open the app in a full tab, and hand the app a session for a chosen org.
// The session id never leaves the browser: it goes straight from chrome.cookies to
// Authorization headers on api.salesforce.com calls made by the app tab.

const SF_HOST_RE = /\.(my\.salesforce\.com|salesforce\.com|force\.com|cloudforce\.com|database\.com)$/;

chrome.action.onClicked.addListener(async (tab) => {
  // If the click came from a Salesforce tab, preselect that org (by org key, since the
  // tab is usually on lightning.force.com while the API lives on my.salesforce.com).
  let preselect = "";
  try {
    const host = new URL(tab?.url || "").hostname;
    if (SF_HOST_RE.test(host)) preselect = orgKey(host);
  } catch { /* not a URL we care about */ }
  const url = chrome.runtime.getURL("app.html") + (preselect ? `#org=${encodeURIComponent(preselect)}` : "");
  chrome.tabs.create({ url });
});

// A Salesforce "session" = the sid cookie for an instance host.
async function sessionFor(host) {
  const cookie = await chrome.cookies.get({ url: `https://${host}`, name: "sid" });
  if (!cookie?.value || !cookie.value.includes("!")) return null;
  return { host, token: cookie.value };
}

// Salesforce drops the same sid cookie on several per-org service domains
// (lightning./file./content./visual.force.com …). Only the API host is useful.
const NOISE_HOST_RE = /(^|\.)(lightning|file|content|visual|documentforce|setup|c)\.|\.vf\.force\.com$|\.visualforce\.com$|\.lightning\.force\.com$|\.file\.force\.com$/;
const API_HOST_RE = /\.my\.salesforce\.com$|\.my\.salesforce-setup\.com$|^[^.]+\.salesforce\.com$|\.cloudforce\.com$|\.database\.com$/;

// A single org may expose several hosts; key by org label so we list it once.
function orgKey(host) {
  return host
    .replace(/\.my\.salesforce(-setup)?\.com$/, "")
    .replace(/\.(lightning|file|content|visual|documentforce)\.force\.com$/, "")
    .replace(/\.salesforce\.com$/, "")
    .toLowerCase();
}

// List every org the user currently has an API-usable session with.
async function listOrgs() {
  const cookies = await chrome.cookies.getAll({ name: "sid" });
  const seen = new Map();
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, "");
    if (!SF_HOST_RE.test(host)) continue;
    if (!c.value.includes("!")) continue;              // not a real session id
    if (/^(login|test)\./.test(host)) continue;        // login endpoints, not instances
    if (NOISE_HOST_RE.test(host)) continue;            // UI/content domains, not the API host
    if (!API_HOST_RE.test(host)) continue;
    const key = orgKey(host);
    // prefer a my.salesforce.com host if several match the same org
    const better = /\.my\.salesforce\.com$/.test(host);
    if (!seen.has(key) || (better && !/\.my\.salesforce\.com$/.test(seen.get(key).host))) {
      seen.set(key, { host, label: key });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    try {
      if (msg?.type === "listOrgs") return respond({ ok: true, orgs: await listOrgs() });
      if (msg?.type === "session") {
        const s = await sessionFor(msg.host);
        return respond(s ? { ok: true, session: s } : { ok: false, error: "No active session for that org — log into it in another tab first." });
      }
      respond({ ok: false, error: "Unknown request" });
    } catch (e) {
      respond({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async response
});
