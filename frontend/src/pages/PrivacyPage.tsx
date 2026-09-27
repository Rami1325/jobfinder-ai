import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Footer from "../components/marketing/Footer";

const GOOGLE_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

const externalLink =
  "font-medium text-accent underline underline-offset-2 hover:text-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}

/**
 * /privacy — what JobFinder keeps, in plain language, in both languages.
 *
 * Under MarketingLayout because it is read BEFORE signing up as
 * often as after: the signup form links here, and so do the landing's Gmail
 * question and both footers.
 *
 * Every sentence describes what the code does, and nothing beyond it. A privacy
 * page that promises more than the product does is worse than none, because it
 * is the page someone reads in order to decide whether to trust the rest.
 * Retention figures are the ones the backend enforces (the 30-day sign-in log),
 * and the Gmail section describes the stored fields the inbox pipeline actually
 * writes.
 *
 * The Limited Use sentence is the disclosure Google requires from apps that
 * read Gmail, with the policy linked where its name falls in the sentence.
 *
 * The Continue with Google sentence (Phase 30 F5) is conditional on purpose: it
 * says what a Google sign-in sends us, and never that the button is there. A
 * static page cannot know whether this server has sign-in configured.
 *
 * The Chrome extension section is the privacy policy the Chrome Web Store
 * listing links to, so it is held to extension/popup.js and options.js: what
 * they read, send, store and write into a page. A change to what the extension
 * collects is a change to this section in both locales, and the Store also
 * requires it to be disclosed in the extension's own popup.
 */
export default function PrivacyPage() {
  const { t } = useTranslation("auth");

  return (
    <>
      <article className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight text-ink rtl:tracking-normal sm:text-4xl">
          {t("privacy.title")}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">{t("privacy.intro")}</p>

        <Block title={t("privacy.store.title")}>
          <ul className="list-disc space-y-2 ps-5">
            <li>{t("privacy.store.account")}</li>
            <li>{t("privacy.store.google")}</li>
            <li>{t("privacy.store.content")}</li>
            <li>{t("privacy.store.usage")}</li>
            <li>{t("privacy.store.steps")}</li>
            <li>{t("privacy.store.security")}</li>
          </ul>
        </Block>

        <Block title={t("privacy.gmail.title")}>
          <p>{t("privacy.gmail.optional")}</p>
          <p>{t("privacy.gmail.reads")}</p>
          <p>{t("privacy.gmail.keeps")}</p>
          <p>{t("privacy.gmail.skips")}</p>
          <p>{t("privacy.gmail.token")}</p>
          <p>
            {t("privacy.gmail.limitedUseBefore")}{" "}
            <a href={GOOGLE_POLICY_URL} target="_blank" rel="noopener noreferrer" className={externalLink}>
              {t("privacy.gmail.policyLink")}
            </a>
            {t("privacy.gmail.limitedUseAfter")}
          </p>
        </Block>

        <Block title={t("privacy.ai.title")}>
          <p>{t("privacy.ai.tools")}</p>
          <p>{t("privacy.ai.voice")}</p>
          <p>{t("privacy.ai.mail")}</p>
        </Block>

        <Block title={t("privacy.extension.title")}>
          <p>{t("privacy.extension.reads")}</p>
          <p>{t("privacy.extension.sends")}</p>
          <p>{t("privacy.extension.fill")}</p>
          <p>{t("privacy.extension.ai")}</p>
          <p>{t("privacy.extension.stores")}</p>
          <p>{t("privacy.extension.none")}</p>
          <p>{t("privacy.extension.remove")}</p>
          <p>{t("privacy.extension.limitedUse")}</p>
        </Block>

        <Block title={t("privacy.remove.title")}>
          <p>{t("privacy.remove.wipe")}</p>
          <p>{t("privacy.remove.close")}</p>
          <p>
            {t("privacy.remove.gmail")}{" "}
            <a href={GOOGLE_PERMISSIONS_URL} target="_blank" rel="noopener noreferrer" className={externalLink}>
              {t("privacy.remove.googleLink")}
            </a>
          </p>
        </Block>
      </article>
      <Footer />
    </>
  );
}
