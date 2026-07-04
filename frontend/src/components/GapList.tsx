import { Check, Minus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GapItem } from "../types";
import { Badge, Card, CardTitle } from "./ui";

const order: Record<string, number> = { missing: 0, partial: 1, covered: 2 };
const icon: Record<string, JSX.Element> = {
  covered: <Check size={12} />,
  partial: <Minus size={12} />,
  missing: <X size={12} />,
};

export default function GapList({ gaps }: { gaps: GapItem[] }) {
  const { t } = useTranslation("tailor");
  if (!gaps.length) return null;
  const sorted = [...gaps].sort((a, b) => order[a.status] - order[b.status]);
  const missing = gaps.filter((g) => g.status === "missing").length;

  return (
    <Card>
      <CardTitle>{t("gaps.title")}</CardTitle>
      <p className="mt-1 text-sm text-ink-muted">
        {t("gaps.summary", { missing, total: gaps.length })}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {sorted.map((g) => (
          <Badge key={g.keyword} tone={g.status as "covered" | "partial" | "missing"} title={g.suggestion}>
            {icon[g.status]} {g.keyword}
          </Badge>
        ))}
      </div>
    </Card>
  );
}
