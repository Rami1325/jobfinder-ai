// The alert's channels beside the email (PLAN 32): this device's notifications.
// Mounted inside AlertsCard, which reads the device list and this browser's
// subscription together with the alert itself, so the card appears whole and
// nothing below it moves when these arrive.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageCircle, Smartphone } from "lucide-react";
import {
  addPushDevice,
  removePushDevice,
  removeWhatsApp,
  sendWhatsAppCode,
  testPushDevice,
  testWhatsApp,
  verifyWhatsApp,
} from "../../api/client";
import { Button, useToast } from "../../components/ui";
import { apiErrorCode, apiErrorMessage } from "../../lib/apiError";
import { PushError, pushPermission, pushSupport, turnOffHere, turnOn, type PushSub } from "../../lib/push";
import type { PushDevices, WhatsAppStatus } from "../../types";
import { inputCls } from "./shared";

/** The app's language as a device's notifications are written in it. */
export function pushLang(language: string): "he" | "en" {
  return language.startsWith("he") ? "he" : "en";
}

/**
 * "Also send to this device": a switch that asks for notification permission
 * only when it is tapped (`turnOn` asks first thing, inside the tap), stores the
 * subscription, and offers a test once it is on. It is drawn only when the
 * server sends notifications at all (`devices.configured`); where this browser
 * cannot, it says why in one line instead (iPhone Safari outside a Home Screen
 * app, a browser with no push). `role="switch"` on a real button with a 44 px
 * hit target, the Settings switch's own shape.
 */
export function PushRow({
  devices,
  here,
  onChange,
}: {
  devices: PushDevices;
  /** This browser's subscription as read on mount (null: none). */
  here: PushSub | null;
  onChange: (devices: PushDevices, here: PushSub | null) => void;
}) {
  const { t, i18n } = useTranslation("jobs");
  const toast = useToast();
  const labelId = useId();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState(() => (pushPermission() === "denied" ? t("alerts.push.denied") : ""));
  const support = pushSupport();

  const mine = here ? devices.devices.find((d) => d.endpoint === here.endpoint) : undefined;
  const on = !!mine && pushPermission() === "granted";
  const others = devices.devices.filter((d) => d.endpoint !== mine?.endpoint).length;

  async function enable() {
    setBusy(true);
    setNote("");
    try {
      // The permission prompt is the FIRST thing `turnOn` does: nothing is
      // awaited before it, so the browser still counts it as this tap's.
      const sub = await turnOn(devices.public_key);
      const saved = await addPushDevice({ ...sub, lang: pushLang(i18n.language) });
      onChange(
        { ...devices, devices: [...devices.devices.filter((d) => d.endpoint !== saved.endpoint), saved] },
        sub,
      );
      toast("success", t("alerts.push.turnedOn"));
    } catch (e) {
      if (e instanceof PushError) setNote(t(`alerts.push.${e.reason}`));
      else if (apiErrorCode(e) === "push_endpoint") setNote(t("alerts.push.serviceNotSupported"));
      else toast("error", apiErrorMessage(e, t("alerts.push.error")));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!here) return;
    setBusy(true);
    setNote("");
    try {
      await removePushDevice(here.endpoint);
      await turnOffHere();
      onChange({ ...devices, devices: devices.devices.filter((d) => d.endpoint !== here.endpoint) }, null);
      toast("success", t("alerts.push.turnedOff"));
    } catch (e) {
      toast("error", apiErrorMessage(e, t("alerts.push.error")));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!here) return;
    setTesting(true);
    try {
      const r = await testPushDevice(here.endpoint);
      if (r.status === "sent") toast("success", t("alerts.push.testSent"));
      else if (r.status === "gone") {
        // The push service disowned it and the server deleted the row: this
        // browser's subscription is dead, so the switch goes off.
        await turnOffHere();
        onChange({ ...devices, devices: devices.devices.filter((d) => d.endpoint !== here.endpoint) }, null);
        toast("error", t("alerts.push.testGone"));
      } else toast("error", t("alerts.push.testFailed"));
    } catch (e) {
      toast("error", apiErrorMessage(e, t("alerts.push.testFailed")));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p id={labelId} className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Smartphone size={14} aria-hidden className="shrink-0 text-accent-soft" />
            {t("alerts.push.label")}
          </p>
          <p id={hintId} className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {support === "supported"
              ? t("alerts.push.hint")
              : support === "ios-install"
                ? t("alerts.push.iosInstall")
                : t("alerts.push.unsupported")}
          </p>
        </div>
        {support === "supported" && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            aria-busy={busy}
            disabled={busy}
            onClick={() => void (on ? disable() : enable())}
            className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg disabled:cursor-wait disabled:opacity-50"
          >
            <span
              aria-hidden
              className={`relative inline-block h-6 w-11 rounded-full border transition-colors group-focus-visible:ring-2 group-focus-visible:ring-accent/60 ${
                on ? "border-accent bg-accent" : "border-line bg-bg-soft"
              }`}
            >
              <span
                className={`absolute start-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${
                  on ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0"
                }`}
              />
            </span>
          </button>
        )}
      </div>
      {note && (
        <p role="status" className="mt-1 text-xs leading-relaxed text-warn">
          {note}
        </p>
      )}
      {(on || others > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {on && (
            <Button size="sm" variant="secondary" loading={testing} onClick={() => void test()} className="min-h-11">
              {t("alerts.push.test")}
            </Button>
          )}
          {others > 0 && <p className="text-xs text-ink-faint">{t("alerts.push.otherDevices", { count: others })}</p>}
        </div>
      )}
    </div>
  );
}

/** The reasons `whatsapp.SendResult` can carry; anything else reads "failed". */
const WA_REASONS = ["not_on_whatsapp", "opted_out", "rate_limited", "template", "payment", "token", "network", "failed"];

/**
 * "Also send on WhatsApp" (PLAN 32, part 2). Drawn only when the server offers
 * it to this account (`status.available`: WhatsApp configured AND the admin's
 * grant), because every message is billed to the owner. Three states, each one
 * screen of a phone: a number with the explicit opt-in (the checkbox names
 * JobFinder, the channel and the way out, Meta's opt-in rule), then the code
 * WhatsApp delivered, then the number in use with a test and a way to stop. A
 * refusal is said in the row, in the reader's language, never as a raw code.
 */
export function WhatsAppRow({
  status,
  onChange,
}: {
  status: WhatsAppStatus;
  onChange: (status: WhatsAppStatus) => void;
}) {
  const { t, i18n } = useTranslation("jobs");
  const toast = useToast();
  const phoneId = useId();
  const codeId = useId();
  const [phone, setPhone] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");

  function say(e: unknown): void {
    const errCode = apiErrorCode(e);
    const detail = (e as { response?: { data?: { detail?: Record<string, unknown> } } })?.response?.data?.detail ?? {};
    if (errCode === "whatsapp_phone") setNote(t("alerts.whatsapp.errPhone"));
    else if (errCode === "whatsapp_opt_in") setNote(t("alerts.whatsapp.errOptIn"));
    else if (errCode === "whatsapp_not_allowed") setNote(t("alerts.whatsapp.errNotAllowed"));
    else if (errCode === "whatsapp_code") {
      const result = detail.result;
      if (result === "wrong") setNote(t("alerts.whatsapp.errWrong", { count: Number(detail.attempts_left) || 0 }));
      else if (result === "locked") setNote(t("alerts.whatsapp.errLocked"));
      else setNote(t("alerts.whatsapp.errExpired"));
    } else if (errCode === "whatsapp_failed") {
      const reason = typeof detail.reason === "string" && WA_REASONS.includes(detail.reason) ? detail.reason : "failed";
      setNote(t(`alerts.whatsapp.reason.${reason}`));
    } else setNote(apiErrorMessage(e, t("alerts.whatsapp.error")));
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNote("");
    try {
      await work();
    } catch (e) {
      say(e);
    } finally {
      setBusy(false);
    }
  }

  const askCode = (number: string) =>
    run(async () => {
      const out = await sendWhatsAppCode({ phone: number, opt_in: optIn || status.opted_in, lang: pushLang(i18n.language) });
      onChange(out.status);
      setEditing(false);
      setCode("");
    });

  const pending = status.code_pending && !status.verified && !editing;
  const live = status.verified && status.opted_in && !editing;
  const lastError = status.last_error && WA_REASONS.includes(status.last_error) ? status.last_error : "";

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
        <MessageCircle size={14} aria-hidden className="shrink-0 text-accent-soft" />
        {t("alerts.whatsapp.label")}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{t("alerts.whatsapp.hint")}</p>

      {live ? (
        <>
          {/* The number is an LTR run inside a Hebrew sentence: FSI…PDI isolate it. */}
          <p className="mt-2 text-sm text-ink">{t("alerts.whatsapp.on", { phone: "⁨" + status.phone + "⁩" })}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              className="min-h-11"
              onClick={() =>
                void run(async () => {
                  const out = await testWhatsApp();
                  onChange(out.status);
                  toast("success", t("alerts.whatsapp.testSent"));
                })
              }
            >
              {t("alerts.whatsapp.test")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className="min-h-11"
              onClick={() =>
                void run(async () => {
                  onChange(await removeWhatsApp());
                  setPhone("");
                  setOptIn(false);
                  toast("success", t("alerts.whatsapp.removed"));
                })
              }
            >
              {t("alerts.whatsapp.remove")}
            </Button>
          </div>
        </>
      ) : pending ? (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              onChange(await verifyWhatsApp(code));
              toast("success", t("alerts.whatsapp.verified"));
            });
          }}
        >
          <p className="text-sm text-ink">{t("alerts.whatsapp.codeSent", { phone: "⁨" + status.phone + "⁩" })}</p>
          <label htmlFor={codeId} className="mt-2 block text-xs font-semibold text-ink-muted">
            {t("alerts.whatsapp.code")}
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              id={codeId}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              className={`${inputCls} min-h-11 w-32 text-center tracking-widest`}
            />
            <Button size="sm" type="submit" loading={busy} disabled={code.length !== 6} className="min-h-11">
              {t("alerts.whatsapp.confirm")}
            </Button>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void askCode(status.phone)}
              className="min-h-11 text-xs font-semibold text-accent-soft hover:underline disabled:opacity-50"
            >
              {t("alerts.whatsapp.newCode")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setPhone(status.phone);
              }}
              className="min-h-11 text-xs font-semibold text-accent-soft hover:underline disabled:opacity-50"
            >
              {t("alerts.whatsapp.changeNumber")}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            void askCode(phone);
          }}
        >
          <label htmlFor={phoneId} className="block text-xs font-semibold text-ink-muted">
            {t("alerts.whatsapp.phone")}
          </label>
          <input
            id={phoneId}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("alerts.whatsapp.phonePlaceholder")}
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            className={`${inputCls} mt-1 min-h-11 w-full max-w-xs`}
          />
          {/* The whole sentence is the checkbox's hit target, 44 px at least. */}
          <label className="mt-1 flex min-h-11 cursor-pointer items-start gap-2 py-2 text-xs leading-relaxed text-ink">
            <input
              type="checkbox"
              checked={optIn}
              onChange={(e) => setOptIn(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span>{t("alerts.whatsapp.optIn")}</span>
          </label>
          <Button size="sm" type="submit" loading={busy} disabled={!optIn || !phone.trim()} className="mt-2 min-h-11">
            {t("alerts.whatsapp.sendCode")}
          </Button>
        </form>
      )}
      {(note || lastError) && (
        <p role="status" className="mt-1 text-xs leading-relaxed text-warn">
          {note || t(`alerts.whatsapp.reason.${lastError}`)}
        </p>
      )}
    </div>
  );
}
