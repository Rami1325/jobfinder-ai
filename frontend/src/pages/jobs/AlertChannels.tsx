// The alert's channels beside the email (PLAN 32): this device's notifications.
// Mounted inside AlertsCard, which reads the device list and this browser's
// subscription together with the alert itself, so the card appears whole and
// nothing below it moves when these arrive.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Smartphone } from "lucide-react";
import { addPushDevice, removePushDevice, testPushDevice } from "../../api/client";
import { Button, useToast } from "../../components/ui";
import { apiErrorCode, apiErrorMessage } from "../../lib/apiError";
import { PushError, pushPermission, pushSupport, turnOffHere, turnOn, type PushSub } from "../../lib/push";
import type { PushDevices } from "../../types";

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
