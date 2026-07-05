/* JobFinder Job Clipper — popup logic.
   Flow: open → extract job from active tab (activeTab + scripting) →
   editable form → POST to {apiUrl}/applications with X-App-Key. */

"use strict";

var DEFAULT_APP_URL = "https://jobfinder-hazel-pi.vercel.app";

function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

function $(id) {
  return document.getElementById(id);
}

function localize() {
  document.documentElement.dir = chrome.i18n.getMessage("@@bidi_dir") || "ltr";
  document.documentElement.lang = chrome.i18n.getMessage("@@ui_locale") || "en";
  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
}

function normalizeUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

async function getSettings() {
  var stored = await chrome.storage.sync.get({
    appUrl: DEFAULT_APP_URL,
    apiUrl: "",
    accessCode: "",
  });
  var appUrl = normalizeUrl(stored.appUrl);
  var apiUrl = normalizeUrl(stored.apiUrl);
  if (!apiUrl && appUrl) apiUrl = appUrl + "/api";
  return { appUrl: appUrl, apiUrl: apiUrl, accessCode: stored.accessCode || "" };
}

/* ------------------------------------------------------------------ */
/* Extractor — injected into the page. MUST be fully self-contained:  */
/* it cannot reference anything from the popup's scope.               */
/* ------------------------------------------------------------------ */
function extractJob() {
  try {
    var MAX_LEN = 15000;

    var pick = function (selectors) {
      var list = selectors.split("|");
      for (var i = 0; i < list.length; i++) {
        var sel = list[i].trim();
        if (!sel) continue;
        try {
          var el = document.querySelector(sel);
          if (el) {
            var text = (el.innerText || el.textContent || "").trim();
            if (text) return text;
          }
        } catch (e) {
          /* invalid selector on this page — keep going */
        }
      }
      return "";
    };

    var clean = function (text) {
      return String(text || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, MAX_LEN);
    };

    var stripHtml = function (html) {
      var div = document.createElement("div");
      div.innerHTML = html;
      return div.innerText || div.textContent || "";
    };

    // JSON-LD JobPosting — most reliable source when a board embeds one,
    // and it survives markup redesigns that break CSS selectors.
    var fromJsonLd = function () {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length; i++) {
        try {
          var data = JSON.parse(scripts[i].textContent);
          var items = Array.isArray(data) ? data : data["@graph"] || [data];
          for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (it && String(it["@type"]).toLowerCase() === "jobposting") {
              return {
                title: String(it.title || ""),
                company:
                  (it.hiringOrganization && String(it.hiringOrganization.name || "")) || "",
                description: it.description ? stripHtml(String(it.description)) : "",
              };
            }
          }
        } catch (e) {
          /* not JSON or not a posting — keep going */
        }
      }
      return null;
    };

    // Structural fallback: a section heading ("About the job") → nearest
    // ancestor that holds substantial text. Needed on LinkedIn's 2026 shell,
    // whose class names are hashed and change per build.
    var descByHeading = function (labels) {
      var heads = document.querySelectorAll("h1,h2,h3,strong");
      for (var i = 0; i < heads.length; i++) {
        var txt = (heads[i].innerText || "").trim().toLowerCase();
        if (labels.indexOf(txt) === -1) continue;
        var p = heads[i].parentElement;
        for (var up = 0; p && up < 6; up++) {
          var t = (p.innerText || "").trim();
          if (t.length > 300) return t;
          p = p.parentElement;
        }
      }
      return "";
    };

    var host = (location.hostname || "").toLowerCase();
    var title = "";
    var company = "";
    var description = "";
    var knownBoard = false;

    if (host.indexOf("linkedin.com") !== -1) {
      knownBoard = true;
      title = pick(
        ".job-details-jobs-unified-top-card__job-title|.top-card-layout__title|h1"
      );
      company = pick(
        '.job-details-jobs-unified-top-card__company-name|.topcard__org-name-link|[data-tracking-control-name*="topcard-org-name"]'
      );
      description = pick(
        ".jobs-description__content|.show-more-less-html__markup|#job-details"
      );
      if (!description) {
        description = descByHeading(["about the job", "על המשרה", "אודות המשרה"]);
      }
      if (!title || !company) {
        // Tab title is stable across shells: "(3) AI Engineer | Baz | LinkedIn"
        var parts = (document.title || "").replace(/^\(\d+\)\s*/, "").split(" | ");
        if (parts.length >= 2 && /linkedin/i.test(parts[parts.length - 1])) {
          if (!title) title = parts[0];
          if (!company && parts.length >= 3) company = parts[1];
        }
      }
    } else if (host.indexOf("drushim.co.il") !== -1) {
      knownBoard = true;
      title = pick("h1");
      company = pick("p.view-on-submit|.job-details-top a");
      var drDesc = pick('.jobDes|.job-details-section|[class*="jobDescription"]');
      var drReq = pick(".job-requirements");
      description = [drDesc, drReq].filter(Boolean).join("\n\n");
    } else if (host.indexOf("jobmaster.co.il") !== -1) {
      knownBoard = true;
      title = pick("h1|.jobTitle");
      var jmDesc = pick("#jobDescriptionContent");
      var jmReq = pick("#jobRequirementsContent");
      description = [jmDesc, jmReq].filter(Boolean).join("\n\n");
    } else if (host.indexOf("alljobs.co.il") !== -1) {
      knownBoard = true;
      title = pick("h1");
      description = pick('[class*="job-content"]|.PT15');
    } else if (
      host.indexOf("comeet.com") !== -1 ||
      host.indexOf("comeet.co") !== -1 ||
      document.querySelector(".positionDetails")
    ) {
      knownBoard = true;
      title = pick("h1");
      description = pick('.positionDetails|[class*="position"]');
    }

    // JSON-LD fills whatever the site branch missed (or everything, on
    // boards we have no selectors for).
    if (!title || !company || !description) {
      var ld = fromJsonLd();
      if (ld) {
        if (!title) title = ld.title;
        if (!company) company = ld.company;
        if (!description) description = ld.description;
      }
    }

    // On a known board, no description means the SPA hasn't rendered it yet —
    // the popup retries a couple of times before settling for the fallback.
    var partial = knownBoard && !description;

    // Generic fallbacks — always return something usable.
    if (!title) title = (document.title || "").trim();
    if (!description) {
      description = (document.body && document.body.innerText) || "";
    }

    return {
      title: clean(title).slice(0, 300),
      company: clean(company).slice(0, 300),
      description: clean(description),
      url: location.href || "",
      partial: partial,
    };
  } catch (err) {
    return {
      title: (document && document.title) || "",
      company: "",
      description: "",
      url: (location && location.href) || "",
      partial: false,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Autofill — injected into the page (PLAN 8.3 assisted apply).        */
/* MUST be fully self-contained; receives a JSON-serializable payload: */
/* { contact:{name,email,phone,location,linkedin,website},             */
/*   coverLetter, file:{name,mime,b64}|null }.                         */
/* Fills the apply form only — NEVER clicks submit.                    */
/* ------------------------------------------------------------------ */
function fillApplicationForm(payload) {
  try {
    var contact = (payload && payload.contact) || {};
    var summary = { fields: 0, file: false, cover: false };

    var nameParts = String(contact.name || "").trim().split(/\s+/).filter(Boolean);
    var firstName = nameParts[0] || "";
    var lastName = nameParts.slice(1).join(" ");

    /* Scope the sweep to where the apply form actually lives, so we never
       touch stray page inputs (job-search boxes, newsletter forms):
       open dialogs with fields (LinkedIn Easy Apply) → forms containing a
       file input (Greenhouse, Comeet, JobMaster) → whole page as last resort. */
    var scopes = [];
    document.querySelectorAll('[role="dialog"], dialog').forEach(function (el) {
      if (el.querySelector("input, textarea, select")) scopes.push(el);
    });
    if (!scopes.length) {
      document.querySelectorAll("form").forEach(function (f) {
        if (f.querySelector('input[type="file"]')) scopes.push(f);
      });
    }
    if (!scopes.length) scopes = [document];

    var candidates = [];
    scopes.forEach(function (scope) {
      scope.querySelectorAll("input, textarea, select").forEach(function (el) {
        if (candidates.indexOf(el) === -1) candidates.push(el);
      });
    });

    var labelText = function (el) {
      var parts = [];
      if (el.id) {
        try {
          var sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]';
          var lab = document.querySelector(sel);
          if (lab) parts.push(lab.innerText || "");
        } catch (e) { /* unescapable id */ }
      }
      var wrap = el.closest ? el.closest("label") : null;
      if (wrap) parts.push(wrap.innerText || "");
      parts.push(el.getAttribute("aria-label") || "");
      parts.push(el.getAttribute("placeholder") || "");
      parts.push(el.getAttribute("name") || "");
      parts.push(el.id || "");
      parts.push(el.getAttribute("autocomplete") || "");
      return parts.join(" ").toLowerCase();
    };

    // React-controlled inputs (LinkedIn, Greenhouse) ignore plain .value
    // writes — go through the native setter, then fire input+change.
    var setNativeValue = function (el, value) {
      var proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // Invisible text fields are honeypots or collapsed steps — filling them
    // can flag the application as a bot. File inputs are exempt (they hide
    // behind custom "Attach" buttons by design).
    var visible = function (el) {
      return !!(el.offsetParent || el.offsetWidth || el.offsetHeight);
    };

    var SKIP_TYPES = {
      hidden: 1, submit: 1, button: 1, reset: 1, image: 1,
      checkbox: 1, radio: 1, password: 1, search: 1,
    };

    var fullNameOk = function (s) {
      if (!/name|שם/.test(s)) return false;
      if (/first|last|family|given|middle|sur|user|company|nick|school|field|file|country|city/.test(s)) return false;
      if (/שם פרטי|שם משפחה|שם החברה|שם משתמש/.test(s)) return false;
      return true;
    };

    // First match wins per element; each key fills at most once. First/last
    // name are checked before full name so "First name" never gets the full
    // string. Hebrew labels cover the Israeli boards.
    var rules = [
      { key: "email", value: contact.email, test: function (s, ty) { return ty === "email" || /e-?mail|אימייל|דוא/.test(s); } },
      { key: "phone", value: contact.phone, test: function (s, ty) { return ty === "tel" || /phone|mobile|טלפון|נייד/.test(s); } },
      { key: "firstName", value: firstName, test: function (s) { return /first[ _-]?name|given[ _-]?name|שם פרטי/.test(s); } },
      { key: "lastName", value: lastName, test: function (s) { return /last[ _-]?name|family[ _-]?name|surname|שם משפחה/.test(s); } },
      { key: "linkedin", value: contact.linkedin, test: function (s) { return /linked[ _-]?in/.test(s); } },
      { key: "website", value: contact.website, test: function (s) { return /website|portfolio|homepage|אתר אישי/.test(s); } },
      { key: "location", value: contact.location, test: function (s) { return /city|location|עיר|מיקום|יישוב/.test(s); } },
      { key: "fullName", value: contact.name, test: function (s) { return fullNameOk(s); } },
    ];
    var done = {};
    var coverRe = /cover[ _-]?letter|motivation letter|מכתב מקדים|מכתב פנייה/;
    var emailRe = /e-?mail|אימייל|דוא/;

    candidates.forEach(function (el) {
      try {
        if (el.disabled || el.readOnly) return;
        var tag = el.tagName;
        if (tag === "INPUT") {
          var ty = (el.getAttribute("type") || "text").toLowerCase();
          if (ty === "file" || SKIP_TYPES[ty]) return;
          if (!visible(el)) return;
          if (String(el.value || "").trim()) return; // never overwrite user input
          var s = labelText(el);
          for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (done[r.key] || !r.value) continue;
            if (r.test(s, ty)) {
              setNativeValue(el, r.value);
              done[r.key] = true;
              summary.fields++;
              break;
            }
          }
        } else if (tag === "TEXTAREA") {
          if (!visible(el) || String(el.value || "").trim()) return;
          if (!payload.coverLetter || summary.cover) return;
          if (coverRe.test(labelText(el))) {
            setNativeValue(el, payload.coverLetter);
            summary.cover = true;
          }
        } else if (tag === "SELECT") {
          // Only email dropdowns (LinkedIn offers verified addresses): pick
          // the option matching the résumé email, otherwise leave untouched.
          if (!visible(el) || done.email || !contact.email) return;
          if (!emailRe.test(labelText(el))) return;
          var target = contact.email.toLowerCase();
          for (var j = 0; j < el.options.length; j++) {
            var o = el.options[j];
            if ((o.value || "").toLowerCase() === target ||
                (o.text || "").toLowerCase().indexOf(target) !== -1) {
              var desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
              if (desc && desc.set) desc.set.call(el, o.value);
              else el.value = o.value;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              done.email = true;
              summary.fields++;
              break;
            }
          }
        }
      } catch (e) { /* one bad element must not stop the sweep */ }
    });

    // Résumé file: the input labeled resume/CV, else the only file input
    // that isn't explicitly for a cover-letter upload.
    if (payload && payload.file && payload.file.b64) {
      var fileInputs = candidates.filter(function (el) {
        return el.tagName === "INPUT" &&
          (el.getAttribute("type") || "").toLowerCase() === "file";
      });
      var resumeRe = /resume|\bcv\b|קורות[ _-]?חיים|קו"ח/;
      var fileTarget = null;
      for (var k = 0; k < fileInputs.length; k++) {
        if (resumeRe.test(labelText(fileInputs[k]))) { fileTarget = fileInputs[k]; break; }
      }
      if (!fileTarget) {
        var plain = fileInputs.filter(function (el) { return !/cover/.test(labelText(el)); });
        if (plain.length === 1) fileTarget = plain[0];
        else if (fileInputs.length === 1) fileTarget = fileInputs[0];
      }
      if (fileTarget && !(fileTarget.files && fileTarget.files.length)) {
        try {
          var bin = atob(payload.file.b64);
          var bytes = new Uint8Array(bin.length);
          for (var b = 0; b < bin.length; b++) bytes[b] = bin.charCodeAt(b);
          var file = new File([bytes], payload.file.name, { type: payload.file.mime });
          var dt = new DataTransfer();
          dt.items.add(file);
          fileTarget.files = dt.files;
          fileTarget.dispatchEvent(new Event("change", { bubbles: true }));
          summary.file = true;
        } catch (e) { /* site blocks programmatic files — user attaches manually */ }
      }
    }

    return summary;
  } catch (err) {
    return { fields: 0, file: false, cover: false };
  }
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */
function showStatus(kind, messageKey, subs, withOptionsLink) {
  var box = $("status");
  box.hidden = false;
  box.className = "status" + (kind ? " " + kind : "");
  $("statusText").textContent = t(messageKey, subs);
  $("statusOptionsLink").hidden = !withOptionsLink;
}

function showApplyStatus(kind, text) {
  var box = $("applyStatus");
  box.hidden = false;
  box.className = "status apply-status" + (kind ? " " + kind : "");
  $("applyStatusText").textContent = text;
}

function hideStatus() {
  $("status").hidden = true;
}

function setSaving(saving) {
  var btn = $("saveBtn");
  btn.disabled = saving;
  btn.textContent = saving ? t("btnSaving") : t("btnSave");
  $("saveTailorBtn").disabled = saving;
}

/* ------------------------------------------------------------------ */
/* Assisted apply (PLAN 8.3): autofill from an approved kit            */
/* ------------------------------------------------------------------ */
var activeTab = null;      // the tab the popup opened on
var approvedKits = [];     // GET /kits, status === "approved"

function apiHeaders(settings, json) {
  var h = json ? { "Content-Type": "application/json" } : {};
  if (settings.accessCode) h["X-App-Key"] = settings.accessCode;
  return h;
}

// host+path+query (JobMaster's job key lives in the query string).
function urlKey(u) {
  try {
    var p = new URL(u);
    return (p.host + p.pathname).toLowerCase().replace(/\/+$/, "") + (p.search || "");
  } catch (e) {
    return String(u || "").toLowerCase().replace(/\/+$/, "");
  }
}

// host+path only — apply pages often add tracking params to the posting URL.
function urlKeyLoose(u) {
  try {
    var p = new URL(u);
    return (p.host + p.pathname).toLowerCase().replace(/\/+$/, "");
  } catch (e) {
    return "";
  }
}

// Duplicate-clip detection (PLAN 9.4): warn — without blocking — when the
// current job's URL is already a tracker application.
async function checkDuplicate(settings, currentUrl) {
  if (!settings.apiUrl || !currentUrl) return;
  var apps = [];
  try {
    var res = await fetch(settings.apiUrl + "/applications", { headers: apiHeaders(settings) });
    if (!res.ok) return; // unconfigured / old backend — hint stays hidden
    apps = (await res.json()) || [];
  } catch (e) {
    return;
  }
  var exact = urlKey(currentUrl);
  var loose = urlKeyLoose(currentUrl);
  var dup = apps.find(function (a) {
    var u = a && a.job_url;
    return u && (urlKey(u) === exact || (loose && urlKeyLoose(u) === loose));
  });
  if (!dup) return;
  if (settings.appUrl) $("dupLink").href = settings.appUrl + "/tracker";
  else $("dupLink").hidden = true;
  $("dupHint").hidden = false;
}

function kitLabel(kit) {
  var label = [kit.job_title, kit.company].filter(Boolean).join(" — ") || kit.url;
  return label.length > 64 ? label.slice(0, 63) + "…" : label;
}

async function loadKits(settings, currentUrl) {
  if (!settings.apiUrl) return;
  var kits = [];
  try {
    var res = await fetch(settings.apiUrl + "/kits", { headers: apiHeaders(settings) });
    if (!res.ok) return; // not configured / old backend — section stays hidden
    kits = (await res.json()).kits || [];
  } catch (e) {
    return;
  }

  var exact = urlKey(currentUrl);
  var loose = urlKeyLoose(currentUrl);
  var matches = function (kit) {
    return urlKey(kit.url) === exact || (loose && urlKeyLoose(kit.url) === loose);
  };

  // A processed-but-unreviewed kit for this very job: point at the review page.
  var pending = kits.find(function (k) { return k.status === "done" && matches(k); });
  if (pending && settings.appUrl) {
    $("reviewLink").href = settings.appUrl + "/kits/" + pending.id;
    $("reviewHint").hidden = false;
  }

  approvedKits = kits.filter(function (k) {
    return k.status === "approved" && k.application_id;
  });
  if (!approvedKits.length) return;

  var select = $("kitSelect");
  select.innerHTML = "";
  var matched = null;
  approvedKits.forEach(function (kit) {
    var opt = document.createElement("option");
    opt.value = String(kit.id);
    opt.textContent = kitLabel(kit);
    select.appendChild(opt);
    if (!matched && matches(kit)) matched = kit;
  });
  if (matched) select.value = String(matched.id);

  $("autofillBtn").addEventListener("click", onAutofill);
  $("applySection").hidden = false;
}

function bufToBase64(buf) {
  var bytes = new Uint8Array(buf);
  var chunks = [];
  for (var i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(""));
}

// Mirrors the app's resumeFilename(): "Rami Bar - AppsFlyer", or "resume".
function resumeFileBase(candidateName, company) {
  var clean = function (s) {
    return String(s || "").replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim();
  };
  var parts = [clean(candidateName), clean(company)].filter(Boolean);
  return parts.join(" - ") || "resume";
}

async function onAutofill() {
  var kit = null;
  var kitId = Number($("kitSelect").value);
  for (var i = 0; i < approvedKits.length; i++) {
    if (approvedKits[i].id === kitId) kit = approvedKits[i];
  }
  if (!kit || !activeTab || activeTab.id == null) return;

  var settings = await getSettings();
  var btn = $("autofillBtn");
  btn.disabled = true;
  btn.textContent = t("btnAutofilling");
  showApplyStatus("", t("autofillPreparing"));

  try {
    // 1. The approved application carries the reviewer's effective résumé +
    //    cover letter (what Approve wrote to the tracker).
    var appRes = await fetch(settings.apiUrl + "/applications/" + kit.application_id, {
      headers: apiHeaders(settings),
    });
    if (!appRes.ok) {
      showApplyStatus(
        "error",
        t(appRes.status === 401 ? "errUnauthorized" : "errKitFetch", [String(appRes.status)])
      );
      return;
    }
    var detail = await appRes.json();
    var resume = detail.tailored_resume;
    var payload = {
      contact: (resume && resume.contact) || {},
      coverLetter: detail.cover_letter || "",
      file: null,
    };

    // 2. Render the résumé file in the chosen format.
    var fmt = document.querySelector('input[name="fmt"]:checked').value;
    if (resume) {
      var rRes = await fetch(settings.apiUrl + "/render", {
        method: "POST",
        headers: apiHeaders(settings, true),
        body: JSON.stringify({ resume: resume, fmt: fmt, template: "classic" }),
      });
      if (rRes.ok) {
        payload.file = {
          name: resumeFileBase(payload.contact.name, kit.company) + "." + fmt,
          mime: fmt === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          b64: bufToBase64(await rRes.arrayBuffer()),
        };
      }
    }

    // 3. Fill every frame we can reach (Greenhouse forms often live in an
    //    iframe; cross-origin frames need their own host permission, so fall
    //    back to the top frame if the allFrames injection is refused).
    var results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id, allFrames: true },
        func: fillApplicationForm,
        args: [payload],
      });
    } catch (e) {
      results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: fillApplicationForm,
        args: [payload],
      });
    }

    var total = { fields: 0, file: false, cover: false };
    (results || []).forEach(function (r) {
      var s = r && r.result;
      if (!s) return;
      total.fields += s.fields || 0;
      total.file = total.file || !!s.file;
      total.cover = total.cover || !!s.cover;
    });

    if (!total.fields && !total.file && !total.cover) {
      showApplyStatus("warn", t("autofillNoForm"));
    } else {
      var parts = [t("autofillFilled", [String(total.fields)])];
      if (total.file) parts.push(t("autofillFileAttached"));
      if (total.cover) parts.push(t("autofillCoverAdded"));
      showApplyStatus("ok", parts.join(" · ") + " " + t("autofillReviewNote"));
    }
  } catch (err) {
    showApplyStatus("error", t("errNetwork"));
  } finally {
    btn.disabled = false;
    btn.textContent = t("btnAutofill");
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */
async function init() {
  localize();

  $("openOptions").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
  });
  $("statusOptionsLink").addEventListener("click", function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $("clipForm").addEventListener("submit", onSave);
  $("saveTailorBtn").addEventListener("click", function () {
    saveClip(true);
  });

  showStatus("", "statusReading");

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  activeTab = tab || null;
  var extracted = null;

  // Assisted apply + duplicate detection: both load in the background while
  // the extractor runs; neither blocks clipping.
  getSettings().then(function (settings) {
    var url = (tab && tab.url) || "";
    return Promise.all([
      loadKits(settings, url),
      checkDuplicate(settings, url),
    ]);
  }).catch(function () { /* hints stay hidden */ });

  if (tab && tab.id != null && /^https?:/i.test(tab.url || "")) {
    try {
      // SPAs (LinkedIn) render the description late; on a known board with
      // no description yet, retry a couple of times before settling.
      for (var attempt = 0; attempt < 3; attempt++) {
        var results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractJob,
        });
        if (results && results[0] && results[0].result) {
          extracted = results[0].result;
        }
        if (!extracted || !extracted.partial) break;
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
    } catch (e) {
      /* injection blocked (store pages, PDFs…) — fall through */
    }
  }

  if (extracted) {
    hideStatus();
    $("jobTitle").value = extracted.title || "";
    $("company").value = extracted.company || "";
    $("jobUrl").value = extracted.url || (tab && tab.url) || "";
    $("jdText").value = extracted.description || "";
  } else {
    showStatus("warn", "statusRestricted");
    $("jobUrl").value = (tab && /^https?:/i.test(tab.url || "") && tab.url) || "";
  }
  $("clipForm").hidden = false;
}

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */
async function onSave(e) {
  e.preventDefault();
  saveClip(false);
}

async function saveClip(openTailor) {
  hideStatus();

  var settings = await getSettings();
  if (!settings.apiUrl) {
    showStatus("error", "errNotConfigured", null, true);
    return;
  }

  var body = {
    job_title: $("jobTitle").value.trim(),
    company: $("company").value.trim(),
    jd_text: $("jdText").value.trim(),
    job_url: $("jobUrl").value.trim(),
    status: "saved",
  };

  setSaving(true);
  try {
    var res = await fetch(settings.apiUrl + "/applications", {
      method: "POST",
      headers: apiHeaders(settings, true),
      body: JSON.stringify(body),
    });

    if (res.ok) {
      if (openTailor && settings.appUrl) {
        // Deep Tailor handoff: the app's Tailor page loads this application's
        // JD via ?tailor_app=<id>. Opening the tab closes the popup.
        var saved = await res.json();
        chrome.tabs.create({ url: settings.appUrl + "/app?tailor_app=" + saved.id });
        return;
      }
      $("clipForm").hidden = true;
      $("applySection").hidden = true;
      $("reviewHint").hidden = true;
      $("openTracker").href = settings.appUrl
        ? settings.appUrl + "/tracker"
        : "#";
      $("success").hidden = false;
    } else if (res.status === 401) {
      showStatus("error", "errUnauthorized", null, true);
    } else {
      showStatus("error", "errServer", [String(res.status)]);
    }
  } catch (err) {
    showStatus("error", "errNetwork", null, true);
  } finally {
    setSaving(false);
  }
}

document.addEventListener("DOMContentLoaded", init);
