import { useTranslation } from "react-i18next";
import { Card, CardTitle } from "./ui";

/** Temporary stand-in for pages delivered in later build phases. */
export default function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mt-2 text-sm text-ink-muted">{t("placeholder.body")}</p>
    </Card>
  );
}
