/* JobFinder Job Clipper — options page.
   Stores appUrl / apiUrl / accessCode in chrome.storage.sync. */

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
}

function normalizeUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

function effectiveApiUrl() {
  var apiUrl = normalizeUrl($("apiUrl").value);
  if (apiUrl) return apiUrl;
  var appUrl = normalizeUrl($("appUrl").value) || DEFAULT_APP_URL;
  return appUrl + "/api";
}

function showMsg(kind, key) {
  var el = $("msg");
  el.className = "inline-msg " + kind;
  el.textContent = t(key);
}

async function load() {
  var stored = await chrome.storage.sync.get({
    appUrl: DEFAULT_APP_URL,
    apiUrl: "",
    accessCode: "",
  });
  $("appUrl").value = stored.appUrl || "";
  $("apiUrl").value = stored.apiUrl || "";
  $("accessCode").value = stored.accessCode || "";
}

async function onSave(e) {
  e.preventDefault();
  await chrome.storage.sync.set({
    appUrl: normalizeUrl($("appUrl").value) || DEFAULT_APP_URL,
    apiUrl: normalizeUrl($("apiUrl").value),
    accessCode: $("accessCode").value.trim(),
  });
  showMsg("ok", "msgSettingsSaved");
}

async function onTest() {
  var btn = $("testBtn");
  btn.disabled = true;
  showMsg("muted", "msgTesting");
  try {
    var res = await fetch(effectiveApiUrl() + "/health", { method: "GET" });
    showMsg(res.ok ? "ok" : "error", res.ok ? "msgTestOk" : "msgTestFail");
  } catch (err) {
    showMsg("error", "msgTestFail");
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  localize();
  load();
  $("settingsForm").addEventListener("submit", onSave);
  $("testBtn").addEventListener("click", onTest);
});
