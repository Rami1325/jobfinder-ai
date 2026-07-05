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

    var host = (location.hostname || "").toLowerCase();
    var title = "";
    var company = "";
    var description = "";

    if (host.indexOf("linkedin.com") !== -1) {
      title = pick(
        ".job-details-jobs-unified-top-card__job-title|.top-card-layout__title|h1"
      );
      company = pick(
        '.job-details-jobs-unified-top-card__company-name|.topcard__org-name-link|[data-tracking-control-name*="topcard-org-name"]'
      );
      description = pick(
        ".jobs-description__content|.show-more-less-html__markup|#job-details"
      );
    } else if (host.indexOf("drushim.co.il") !== -1) {
      title = pick("h1");
      description = pick('.job-details-section|[class*="jobDescription"]');
    } else if (host.indexOf("jobmaster.co.il") !== -1) {
      title = pick("h1|.jobTitle");
      var jmDesc = pick("#jobDescriptionContent");
      var jmReq = pick("#jobRequirementsContent");
      description = [jmDesc, jmReq].filter(Boolean).join("\n\n");
    } else if (host.indexOf("alljobs.co.il") !== -1) {
      title = pick("h1");
      description = pick('[class*="job-content"]|.PT15');
    } else if (
      host.indexOf("comeet.com") !== -1 ||
      host.indexOf("comeet.co") !== -1 ||
      document.querySelector(".positionDetails")
    ) {
      title = pick("h1");
      description = pick('.positionDetails|[class*="position"]');
    }

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
    };
  } catch (err) {
    return {
      title: (document && document.title) || "",
      company: "",
      description: "",
      url: (location && location.href) || "",
    };
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

function hideStatus() {
  $("status").hidden = true;
}

function setSaving(saving) {
  var btn = $("saveBtn");
  btn.disabled = saving;
  btn.textContent = saving ? t("btnSaving") : t("btnSave");
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

  showStatus("", "statusReading");

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  var extracted = null;

  if (tab && tab.id != null && /^https?:/i.test(tab.url || "")) {
    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractJob,
      });
      if (results && results[0] && results[0].result) {
        extracted = results[0].result;
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
    var headers = { "Content-Type": "application/json" };
    if (settings.accessCode) headers["X-App-Key"] = settings.accessCode;

    var res = await fetch(settings.apiUrl + "/applications", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (res.ok) {
      $("clipForm").hidden = true;
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
