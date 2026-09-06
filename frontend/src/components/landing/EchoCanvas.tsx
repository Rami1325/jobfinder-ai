import { useEffect, useRef } from "react";
import { Starfield, type StarfieldMode } from "../../lib/starfield";

/**
 * The faint echo of the hero's formation behind the closing invitation.
 *
 * It is the SAME sculpture — `Starfield` is seeded, so this is literally the
 * arrangement the hero draws, at a lower density and a much lower opacity —
 * and it is emphatically NOT a second particle engine. There is no
 * `requestAnimationFrame` in this file, no pointer listener and no
 * IntersectionObserver: it draws exactly one frame, and one more per resize.
 * That is the whole component, and it is a separate file from
 * `StarfieldCanvas` for precisely that reason — the loop cannot be started
 * here by accident.
 *
 * A CSS gradient was the first version and it is still underneath (`.lp-echo`,
 * which is also what a browser with no 2D context gets). What a gradient
 * cannot do is rhyme with the opening; this can, for one draw.
 */
export default function EchoCanvas({ mode }: { mode: StarfieldMode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<Starfield | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    let field: Starfield;
    try {
      field = new Starfield(canvas, { count: 420, maxDpr: 1.75 });
    } catch {
      return; // the `.lp-echo` gradient underneath is the whole picture
    }
    if (!field.ok) return;
    field.setMode(mode);
    fieldRef.current = field;

    const paint = () => {
      const box = host.getBoundingClientRect();
      field.resize(canvas, box.width, box.height);
      field.draw();
    };
    paint();

    const ro = new ResizeObserver(paint);
    ro.observe(host);
    return () => {
      ro.disconnect();
      fieldRef.current = null;
    };
  }, [mode]);

  return (
    <div ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0">
      <canvas ref={canvasRef} className="h-full w-full opacity-55" />
    </div>
  );
}
