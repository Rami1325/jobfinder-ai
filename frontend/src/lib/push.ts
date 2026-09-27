/**
 * Web push on this device (PLAN 32): whether it can, and turning it on and off.
 *
 * The browser's permission prompt is asked in exactly one place, `turnOn`, and
 * `turnOn` asks it FIRST, before anything is awaited: a page may only ask from a
 * tap (Safari refuses outside one, and Chrome quiets sites that ask on load), so
 * the Settings switch is the one caller and nothing here runs on mount except
 * the read-only `currentEndpoint`. The service worker (`/sw.js`, push and
 * notificationclick only) is registered on that same tap, never on page load.
 * check-mirrors 91 pins both.
 *
 * iOS: Safari delivers web push only to a web app added to the Home Screen, on
 * iOS/iPadOS 16.4 or later, so a tab in Safari (or any iOS browser, all WebKit)
 * is told to add JobFinder to the Home Screen first rather than shown a switch
 * that cannot work.
 */

export type PushSupport = "supported" | "unsupported" | "ios-install";

function isIos(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function hasPushApis(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Can this device get notifications from this page? */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  if (isIos() && !isStandalone()) return "ios-install";
  return hasPushApis() ? "supported" : "unsupported";
}

/** The site's notification permission as the browser holds it right now. */
export function pushPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Why turning it on stopped: the person said no, closed the prompt, or the
 * browser could not subscribe (a private window, a push service it cannot reach). */
export class PushError extends Error {
  constructor(readonly reason: "denied" | "dismissed" | "failed") {
    super(reason);
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const held = sub.options?.applicationServerKey;
  if (!held) return false;
  const bytes = new Uint8Array(held);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!hasPushApis()) return undefined;
  return navigator.serviceWorker.getRegistration("/");
}

/** A subscription as the server stores it. */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function asSub(sub: PushSubscription | null): PushSub | null {
  if (!sub) return null;
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh ?? "";
  const auth = json.keys?.auth ?? "";
  return sub.endpoint && p256dh && auth ? { endpoint: sub.endpoint, keys: { p256dh, auth } } : null;
}

/** This browser's subscription, if it holds one; null otherwise. Read-only:
 * it registers nothing and asks nothing, so it is safe on mount. */
export async function currentSubscription(): Promise<PushSub | null> {
  try {
    const reg = await registration();
    return asSub(reg ? await reg.pushManager.getSubscription() : null);
  } catch {
    return null;
  }
}

/** Ask for permission, register the worker and subscribe with the server's
 * key. Call it straight from a tap. A subscription made with another key (the
 * server's keys were replaced) is dropped and made again. */
export async function turnOn(publicKey: string): Promise<PushSub> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") throw new PushError("denied");
  if (permission !== "granted") throw new PushError("dismissed");
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const key = keyBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const out = asSub(sub);
    if (!out) throw new PushError("failed");
    return out;
  } catch (e) {
    if (e instanceof PushError) throw e;
    throw new PushError("failed");
  }
}

/** Drop this browser's subscription; the endpoint it had, for the server to
 * forget, or null when there was none. */
export async function turnOffHere(): Promise<string | null> {
  try {
    const reg = await registration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => false);
    return endpoint;
  } catch {
    return null;
  }
}
