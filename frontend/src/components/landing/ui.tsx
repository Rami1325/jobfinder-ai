import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { withNext } from "../../lib/safeNext";

/**
 * The landing's own three primitives.
 *
 * They are deliberately NOT `components/ui/Button` and `marketing/Reveal`.
 * The shared Button is an app control — accent fill, glow shadow, click spark,
 * and a `<Link>` wrapped around it at every call site, which is a link
 * containing a button and is the one accessibility defect the brief names in
 * the current page. The landing's primary action is a link, so here it is one
 * element: an anchor that looks like a pill.
 */

/* -------------------------------------------------------------------------- */
/* Call to action                                                             */
/* -------------------------------------------------------------------------- */

const CTA_BASE =
  "inline-flex min-h-[48px] items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium " +
  "transition-[background-color,border-color,color,transform] duration-150 ease-out-quint " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-bg motion-safe:hover:-translate-y-px";

const CTA_VARIANT = {
  /** Inverted pill: near-white on the dark art direction, near-black on paper. */
  primary: "bg-[rgb(var(--cta-fill))] text-[rgb(var(--cta-ink))] hover:bg-[rgb(var(--cta-fill)/0.88)]",
  /** A hairline the visitor can actually see — never the decorative divider. */
  secondary:
    "border border-ink/25 text-ink hover:border-ink/50 hover:bg-ink/[0.06]",
} as const;

interface CtaProps {
  to: string;
  variant?: keyof typeof CTA_VARIANT;
  className?: string;
  children: ReactNode;
  arrow?: boolean;
}

/** A router link styled as a pill. One element, one role, one focus stop. */
export function Cta({ to, variant = "primary", className, children, arrow }: CtaProps) {
  return (
    <Link to={to} className={cn(CTA_BASE, CTA_VARIANT[variant], className)}>
      {children}
      {arrow && <ArrowRight size={17} aria-hidden className="rtl:-scale-x-100" />}
    </Link>
  );
}

/**
 * The sign-up door to a feature: `/signup?next=<dest>`.
 *
 * Every feature is login first, the CV scan included, so a public call to
 * action that starts one points here, and the landing and the marketing shell
 * spell that rule once. `withNext` leaves the default destination off, so the
 * door to /app is a plain /signup, and SignupPage forwards a visitor who is
 * already signed in straight to `next`. check-mirrors 32(a) holds every link on
 * those pages to this, or to a door a signed-out visitor can use as they are.
 */
export function signupFor(dest: string): string {
  return withNext("/signup", dest);
}

/* -------------------------------------------------------------------------- */
/* Section entrance                                                           */
/* -------------------------------------------------------------------------- */

const canObserve = () => typeof IntersectionObserver !== "undefined";

/**
 * Fade-and-settle, once, when the section reaches the viewport.
 *
 * Two rules from the brief are implemented here rather than trusted:
 * `prefers-reduced-motion` returns the children with NO wrapper state at all
 * (no transition to collapse, no chance of a stuck frame), and a missing or
 * silent IntersectionObserver reveals everything after 900 ms — a section left
 * at `opacity: 0` because an observer never initialised is the failure this
 * page can least afford.
 */
export function Rise({
  children,
  className,
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "li" | "section";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    const safety = window.setTimeout(() => setShown(true), 900);
    if (!el || !canObserve()) return () => window.clearTimeout(safety);
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setShown(true);
        io.disconnect();
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => {
      window.clearTimeout(safety);
      io.disconnect();
    };
  }, []);

  if (reduce) return <Tag className={className}>{children}</Tag>;

  return (
    <Tag
      ref={ref as never}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(16px)",
        transition: `opacity .55s cubic-bezier(.22,1,.36,1) ${delay}s, transform .55s cubic-bezier(.22,1,.36,1) ${delay}s`,
        willChange: shown ? undefined : "opacity, transform",
      }}
    >
      {children}
    </Tag>
  );
}

/* -------------------------------------------------------------------------- */
/* Section furniture                                                          */
/* -------------------------------------------------------------------------- */

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[13px] font-medium uppercase tracking-[0.18em] text-ink-faint rtl:tracking-normal">
      {children}
    </p>
  );
}

/** The one section shell: consistent gutters, width and vertical rhythm. */
export function Section({
  id,
  children,
  className,
  labelledBy,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("px-5 py-16 sm:px-8 md:py-[7rem] lg:px-14", className)}
    >
      <div className="mx-auto w-full max-w-[1160px]">{children}</div>
    </section>
  );
}
