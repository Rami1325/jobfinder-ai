import { Card, CardTitle } from "./ui";

/** Temporary stand-in for pages delivered in later build phases. */
export default function Placeholder({ title }: { title: string }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mt-2 text-sm text-ink-muted">This section is being built. Check back shortly.</p>
    </Card>
  );
}
