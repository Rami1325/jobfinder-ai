import { useEffect, useRef, type RefObject } from "react";
import { Starfield, type StarfieldMode } from "../../lib/starfield";

/**
 * Lifecycle owner for the hero's star sculpture.
 *
 * Everything that runs at frame rate lives in `lib/starfield.ts` and is held
 * in a ref. This component only decides WHEN it may draw, and it is stricter
 * about that than it looks:
 *
 *   - offscreen (IntersectionObserver) or a hidden document => no frames are
 *     scheduled at all, not merely skipped inside the callback;
 *   - `prefers-reduced-motion`, a coarse pointer, or the visitor's own Pause
 *     control => one composed still frame and no loop;
 *   - a lost or unavailable 2D context => the still CSS composition underneath
 *     is the whole picture, and nothing here throws.
 *
 * The first frame is drawn SYNCHRONOUSLY on mount, so the static scene exists
 * before any loop starts and the page never shows an empty black rectangle.
 *
 * The canvas is decorative: `aria-hidden`, `pointer-events: none`. Pointer
 * tracking listens on the hero CONTAINER, so links and buttons above it are
 * never intercepted and the page scrolls normally.
 */

export interface StarfieldCanvasProps {
  /**
   * The HERO box. Pointer coordinates are normalised against its rect, and its
   * height is what the composition is laid out against — which is not the same
   * as the drawing surface, because the scene deliberately overhangs the hero
   * and fades out below it.
   */
  containerRef: RefObject<HTMLElement>;
  /**
   * The box the canvas FILLS. Defaults to the hero. When the scene overhangs,
   * this is the taller element, and the two are kept distinct so the overhang
   * adds room for the arms without moving the sculpture.
   */
  sceneRef?: RefObject<HTMLElement>;
  /** Copy block the sculpture must stay behind. Its bounds dim the particles. */
  readingRef?: RefObject<HTMLElement>;
  /** Visitor's Pause control. */
  paused: boolean;
  mode: StarfieldMode;
  /**
   * Reports whether this device/preference combination animates AT ALL, so the
   * hero can hide the Pause control when there is nothing to pause. It is
   * deliberately not "is currently animating": that would go false the instant
   * the visitor pressed Pause and take the Resume button away with it.
   */
  onCapableChange?: (capable: boolean) => void;
}

/** Particle budget by viewport. Composition matters more than the number. */
function tuningFor(w: number) {
  if (w >= 1280) return { count: 1450, maxDpr: 2 };
  if (w >= 768) return { count: 720, maxDpr: 2 };
  return { count: 300, maxDpr: 1.75 };
}

export default function StarfieldCanvas({
  containerRef,
  sceneRef,
  readingRef,
  paused,
  mode,
  onCapableChange,
}: StarfieldCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<Starfield | null>(null);

  // Frame-rate state. Refs, never state: a setState here would re-render the
  // whole landing on every pointer move.
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const rectRef = useRef<DOMRect | null>(null);
  const onscreenRef = useRef(true);
  const pausedRef = useRef(paused);
  const reduceRef = useRef(false);
  const fineRef = useRef(false);

  // ---- create, size, and paint the still frame ----------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = containerRef.current;
    const scene = sceneRef?.current ?? host;
    if (!canvas || !host || !scene) return;

    let field: Starfield;
    try {
      field = new Starfield(canvas, tuningFor(window.innerWidth));
    } catch {
      // No 2D context: the CSS composition underneath stands alone, and there
      // is now nothing for the visitor's Pause control to pause.
      onCapableChange?.(false);
      return;
    }
    if (!field.ok) {
      onCapableChange?.(false);
      return;
    }
    fieldRef.current = field;

    const measureZone = () => {
      const el = readingRef?.current;
      // Both the reading zone and the pointer are in SCENE coordinates: the
      // canvas fills the scene box, and the parallax has to answer the pointer
      // anywhere the galaxy is visible — including the third of it that hangs
      // below the hero.
      const box = scene.getBoundingClientRect();
      rectRef.current = box;
      if (!el) return field.setReadingZone(null);
      const r = el.getBoundingClientRect();
      field.setReadingZone({
        cx: r.left - box.left + r.width / 2,
        cy: r.top - box.top + r.height / 2,
        // Tight to the copy. The block is already ~1040x500 CSS px on a
        // desktop; padding it generously turns the "reading zone" into most of
        // the hero and dims the sculpture out of existence.
        hw: r.width / 2 + 16,
        hh: r.height / 2 + 16,
      });
    };

    const sizeToHost = () => {
      const box = scene.getBoundingClientRect();
      field.resize(canvas, box.width, box.height, host.getBoundingClientRect().height);
      measureZone();
      field.draw();
    };

    sizeToHost();

    // The container's box changes for reasons the window never hears about —
    // a language switch reflowing the headline, a font landing, the address
    // bar collapsing on a phone. Observe the box, not the window.
    const ro = new ResizeObserver(sizeToHost);
    ro.observe(host);
    if (scene !== host) ro.observe(scene);
    const readEl = readingRef?.current;
    if (readEl) ro.observe(readEl);

    const io = new IntersectionObserver(
      ([e]) => {
        onscreenRef.current = e.isIntersecting;
      },
      { rootMargin: "120px" },
    );
    io.observe(host);

    // The rect is cached and refreshed here rather than read per pointer
    // event, which would be a forced layout at pointer frequency.
    const onScroll = () => {
      rectRef.current = scene.getBoundingClientRect();
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const onLost = (e: Event) => {
      // Keep the default prevented so the context can be restored, but stop
      // drawing and withdraw the Pause control: the still CSS scene is the
      // whole picture from here.
      e.preventDefault();
      fieldRef.current = null;
      onCapableChange?.(false);
    };
    canvas.addEventListener("contextlost", onLost);

    return () => {
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      canvas.removeEventListener("contextlost", onLost);
      fieldRef.current = null;
    };
  }, [containerRef, sceneRef, readingRef, onCapableChange]);

  // ---- palette -----------------------------------------------------------
  useEffect(() => {
    const f = fieldRef.current;
    if (!f) return;
    f.setMode(mode);
    f.draw();
  }, [mode]);

  // ---- the loop ----------------------------------------------------------
  useEffect(() => {
    pausedRef.current = paused;
    const host = containerRef.current;
    const scene = sceneRef?.current ?? host;
    if (!host || !scene) return;

    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mqFine = window.matchMedia("(hover: hover) and (pointer: fine)");

    let stopped = false;

    const animated = () =>
      fieldRef.current !== null && !pausedRef.current && !reduceRef.current && fineRef.current;

    const tick = (now: number) => {
      rafRef.current = 0;
      const f = fieldRef.current;
      if (stopped || !f) return;
      // A stall (tab restore, long task) must not jump the ambient rotation.
      const dt = Math.min((now - lastRef.current) / 1000, 0.05);
      lastRef.current = now;
      f.step(dt > 0 ? dt : 0.016);
      f.draw();
      schedule();
    };

    const schedule = () => {
      if (stopped || rafRef.current) return;
      if (!animated() || !onscreenRef.current || document.hidden) return;
      rafRef.current = requestAnimationFrame(tick);
    };

    const start = () => {
      lastRef.current = performance.now();
      schedule();
    };

    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };

    const sync = () => {
      const on = animated();
      onCapableChange?.(fieldRef.current !== null && !reduceRef.current && fineRef.current);
      if (on) {
        start();
      } else {
        stop();
        // Settle to the neutral composition rather than freezing mid-parallax.
        fieldRef.current?.neutralise();
        fieldRef.current?.draw();
      }
    };

    const onReduce = () => {
      reduceRef.current = mqReduce.matches;
      sync();
    };
    const onFine = () => {
      fineRef.current = mqFine.matches;
      sync();
    };

    // Frames are scheduled, not merely skipped: an offscreen or hidden scene
    // does no work at all.
    //
    // It observes the SCENE, not the hero. The scene overhangs the hero by 32%,
    // so watching the hero stopped the loop while up to 288px of galaxy was
    // still on screen — the arms froze mid-drift exactly where the visitor was
    // looking at them.
    const io = new IntersectionObserver(
      ([e]) => {
        onscreenRef.current = e.isIntersecting;
        if (e.isIntersecting) start();
        else stop();
      },
      { rootMargin: "120px" },
    );
    io.observe(scene);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // POINTER TRACKING IS ON THE WINDOW, AND NORMALISED AGAINST THE SCENE.
    //
    // It used to listen on the hero and normalise against the hero, which was
    // right while the scene and the hero were the same box. Once the scene
    // started overhanging, the lower third of the galaxy sat inside the NEXT
    // section — whose content is on top and is not a hero descendant, and the
    // scene layer itself is `pointer-events: none` and can never be a target.
    // So moving over the visible lower arms fired `pointerleave` on the hero
    // and eased the whole thing back to neutral. Measured before the fix: the
    // same horizontal sweep moved the arms 27.9px inside the hero and 2.9px
    // over the overhang, i.e. not at all.
    //
    // Normalising against the scene also moves the neutral point from the
    // hero's centre to the scene's, which is about two thirds down the hero —
    // right about where the nucleus sits. Resting on the bright knot is a
    // better zero than an arbitrary one.
    //
    // Still no layout read per event: the handler stores coordinates against
    // the cached rect, which scroll and resize refresh.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !animated()) return;
      const r = rectRef.current ?? scene.getBoundingClientRect();
      if (!r.width || !r.height) return;
      fieldRef.current?.setPointerTarget(
        (2 * (e.clientX - r.left)) / r.width - 1,
        (2 * (e.clientY - r.top)) / r.height - 1,
      );
      start();
    };
    // The pointer LEAVING is now leaving the window, not leaving the hero.
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === "mouse") fieldRef.current?.releasePointer();
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave, { passive: true });

    reduceRef.current = mqReduce.matches;
    fineRef.current = mqFine.matches;
    mqReduce.addEventListener("change", onReduce);
    mqFine.addEventListener("change", onFine);
    sync();

    return () => {
      stopped = true;
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      mqReduce.removeEventListener("change", onReduce);
      mqFine.removeEventListener("change", onFine);
    };
  }, [containerRef, sceneRef, paused, onCapableChange]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
