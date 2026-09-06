/**
 * The landing hero's star sculpture — a seeded 3D particle formation drawn
 * with Canvas 2D and projected through a small perspective camera.
 *
 * WHY CANVAS AND NOT A SCENE LIBRARY. The effect needs perspective depth and
 * ~1400 points; that is a matrix multiply and a `drawImage` per point. Adding
 * three.js to the entry chunk of a page whose whole job is to render a
 * headline fast would cost ~150 kB gzip to save about 120 lines.
 *
 * WHY IT IS A CLASS AND NOT A HOOK. Everything in here runs at frame rate and
 * must never touch React state — a `setState` per pointer event re-renders the
 * whole landing 120 times a second. The component owns one instance in a ref
 * and calls methods on it; React never sees a frame.
 *
 * THE GEOMETRY IS SEEDED. `mulberry32` from a fixed seed, so the formation is
 * the same sculpture on every load and on every machine: the composition was
 * designed by looking at it, and a random one would be a different picture
 * each time. It also means the static fallback and the animated scene are the
 * same arrangement, not two drawings that merely resemble each other.
 *
 * DRAW ORDER IS SORTED ONCE, AT BUILD TIME, by (halo kind, tint). Canvas
 * `fillStyle` takes a string and re-parses it on assignment, so setting it per
 * particle is the one genuinely expensive thing in a loop this size. Sorted,
 * the whole frame costs at most three `fillStyle` assignments. `globalAlpha`
 * is a number and is free to set per particle.
 *
 * COMPOSITING IS THE PALETTE'S JOB. On the dark art direction the points are
 * light on near-black, so they are drawn with `lighter` and overlapping stars
 * genuinely add up — which is what makes the core knot read as a luminous
 * concentration rather than a crowd of discs. On the light art direction that
 * would bleach the page white, so the light palette draws blue-grey ink with
 * `source-over` and a much quieter halo. Same geometry, two inks.
 */

export type StarfieldMode = "dark" | "light";

/** Screen-space reading zone the sculpture must stay out of, in CSS px. */
export interface ReadingZone {
  cx: number;
  cy: number;
  /** Half-width / half-height of the protected ellipse. */
  hw: number;
  hh: number;
}

export interface StarfieldTuning {
  /** Particle budget. Composition matters more than this number. */
  count: number;
  /** Device-pixel-ratio ceiling. */
  maxDpr: number;
}

/* -------------------------------------------------------------------------- */
/* Motion contract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Proposed values, tuned by looking at the result — not measurements of any
 * other site. `smoothingRate` is per SECOND: the per-frame blend factor is
 * derived from it and `dt`, so the settle takes the same wall-clock time at
 * 60 Hz and at 144 Hz.
 */
export const MOTION = {
  smoothingRate: 8,
  maxYaw: (4 * Math.PI) / 180,
  maxPitch: (2.5 * Math.PI) / 180,
  /** Depth-weighted pointer travel, CSS px, by layer. */
  travelPx: [5, 14, 26] as const,
  /** Ambient roll of the disc about its own axis, radians per second. */
  spinRate: 0.0125,
};

/* -------------------------------------------------------------------------- */
/* Seeded noise                                                               */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, driven by the seeded stream so the whole scene stays stable. */
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-7);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

/** Cool white, faint blue, warm white — the only three inks in the scene. */
const TINTS_DARK: [number, number, number][] = [
  [232, 240, 252],
  [150, 190, 255],
  [255, 232, 198],
];
/** The light art direction is designed, not inverted: subdued blue-greys. */
const TINTS_LIGHT: [number, number, number][] = [
  [78, 96, 122],
  [58, 92, 152],
  [122, 106, 96],
];

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/* -------------------------------------------------------------------------- */
/* The sculpture                                                              */
/* -------------------------------------------------------------------------- */

const ARMS = 3;
/** How far the arms wind. Higher is a tighter spiral. */
const TWIST = 4.3;
/**
 * Camera distance and focal length in scene units (disc radius = 1). The ratio
 * is what sets how strongly depth reads: the near edge of the disc projects
 * about 1.8x the size of the far edge at these values.
 */
const CAM = 2.72;
const FOCAL = 1.95;
/**
 * Fixed rake. The disc lies in the x-z plane and the camera looks down -z, so
 * `|sin(TILT)|` IS the ellipse's vertical radius: 0 is edge-on (a line) and
 * pi/2 is face-on (a circle). -0.78 rad gives 0.70 — open enough to read as a
 * spiral, raked enough to read as a plane in space.
 */
const TILT = -0.78;
const ROLL = -0.26;

interface Geometry {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  phase: Float32Array;
  rate: Float32Array;
  layer: Uint8Array;
  tint: Uint8Array;
  /** 0 = bare core, 1 = soft halo, 2 = glint. */
  halo: Uint8Array;
}

/**
 * Build the formation: a sparse distant field, three logarithmic arms with
 * uneven density, and a small bright concentration at the centre.
 *
 * Returned sorted by (halo, tint) — see the header note on `fillStyle`.
 */
export function buildGeometry(count: number, seed = 0x5eed1a): Geometry {
  const rnd = mulberry32(seed);
  const nField = Math.round(count * 0.22);
  const nCore = Math.round(count * 0.12);
  const nArms = count - nField - nCore;

  const raw: {
    x: number; y: number; z: number; size: number; alpha: number;
    phase: number; rate: number; layer: number; tint: number; halo: number;
  }[] = [];

  // --- distant field ------------------------------------------------------
  // Kept close enough that it actually lands inside the frame: pushed out to
  // three disc radii most of it projects off screen, which spends a third of
  // the budget on stars nobody sees and leaves the corners looking like
  // debris rather than a field.
  for (let i = 0; i < nField; i++) {
    const r = 0.85 + Math.pow(rnd(), 0.7) * 1.5;
    const th = rnd() * Math.PI * 2;
    raw.push({
      x: Math.cos(th) * r * (0.9 + rnd() * 0.45),
      y: (rnd() * 2 - 1) * 0.78,
      z: Math.sin(th) * r * (0.9 + rnd() * 0.45),
      size: 0.85 + rnd() * 0.6,
      alpha: 0.12 + rnd() * 0.22,
      phase: rnd() * Math.PI * 2,
      rate: 0.15 + rnd() * 0.35,
      layer: 0,
      tint: rnd() < 0.12 ? 1 : 0,
      halo: rnd() < 0.035 ? 1 : 0,
    });
  }

  // --- the arms ------------------------------------------------------------
  for (let i = 0; i < nArms; i++) {
    // Bias toward the middle radii so the arms read as arms, not as a disc.
    const t = Math.pow(rnd(), 0.58);
    const r = 0.22 + t * 1.05;
    const arm = i % ARMS;
    // Arm width narrows outward, which is what gives the sweep its taper. Wide
    // enough and the three arms merge into one disc of dust, which is what the
    // first pass looked like.
    const spread = (0.155 / (0.5 + r * 1.9)) * (0.7 + rnd() * 0.75);
    const th = (arm * 2 * Math.PI) / ARMS + r * TWIST + gauss(rnd) * spread;
    // Uneven density: knots along each arm rather than a smooth ribbon. The
    // period is long enough to read as variation and not as banding.
    const knot = 0.58 + 0.42 * Math.abs(Math.sin(r * 3.9 + arm * 2.1));
    // A HANDFUL of near glints, not a field of them: at 5.5% the cross flares
    // stopped being highlights and became the picture. Every Nth particle
    // rather than a probability, so they sit along the arms instead of
    // clustering wherever the stream happened to roll low.
    const near = i % 97 === 11;
    const bright = rnd() < 0.2;
    raw.push({
      x: Math.cos(th) * r,
      y: gauss(rnd) * 0.055 * (1.25 - 0.6 * r),
      z: Math.sin(th) * r,
      size: near ? 1.5 + rnd() * 1.1 : 0.85 + rnd() * 0.95,
      alpha: (0.42 + rnd() * 0.66) * knot,
      phase: rnd() * Math.PI * 2,
      rate: 0.2 + rnd() * 0.5,
      layer: near ? 2 : 1,
      tint: rnd() < 0.16 ? 1 : rnd() < 0.06 ? 2 : 0,
      halo: near ? 2 : bright ? 1 : 0,
    });
  }

  // --- the core knot -------------------------------------------------------
  for (let i = 0; i < nCore; i++) {
    const r = Math.pow(rnd(), 1.7) * 0.15;
    const th = rnd() * Math.PI * 2;
    raw.push({
      x: Math.cos(th) * r,
      y: gauss(rnd) * 0.045,
      z: Math.sin(th) * r,
      size: 0.85 + rnd() * 0.95,
      // Kept modest on purpose: `lighter` accumulates, so the concentration
      // gets its brightness from density, not from each point being loud.
      alpha: 0.3 + rnd() * 0.34,
      phase: rnd() * Math.PI * 2,
      rate: 0.25 + rnd() * 0.5,
      layer: 1,
      tint: rnd() < 0.3 ? 2 : 0,
      halo: rnd() < 0.5 ? 1 : 0,
    });
  }

  raw.sort((a, b) => a.halo - b.halo || a.tint - b.tint);

  const n = raw.length;
  const g: Geometry = {
    n,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    size: new Float32Array(n), alpha: new Float32Array(n),
    phase: new Float32Array(n), rate: new Float32Array(n),
    layer: new Uint8Array(n), tint: new Uint8Array(n), halo: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const p = raw[i];
    g.x[i] = p.x; g.y[i] = p.y; g.z[i] = p.z;
    g.size[i] = p.size; g.alpha[i] = p.alpha;
    g.phase[i] = p.phase; g.rate[i] = p.rate;
    g.layer[i] = p.layer; g.tint[i] = p.tint; g.halo[i] = p.halo;
  }
  return g;
}

/* -------------------------------------------------------------------------- */
/* Glow sprites                                                               */
/* -------------------------------------------------------------------------- */

const SPRITE_PX = 128;

/**
 * One pre-rendered radial glow per tint, drawn scaled. Building a gradient per
 * particle per frame — or leaning on `shadowBlur` — is the classic way to turn
 * this scene into a 12 fps slideshow.
 */
function makeSprites(tints: [number, number, number][], soft: number): HTMLCanvasElement[] {
  return tints.map((c) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = SPRITE_PX;
    const g = cv.getContext("2d");
    if (!g) return cv;
    const h = SPRITE_PX / 2;
    const grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},1)`);
    grad.addColorStop(0.14, `rgba(${c[0]},${c[1]},${c[2]},${0.62 * soft})`);
    grad.addColorStop(0.36, `rgba(${c[0]},${c[1]},${c[2]},${0.17 * soft})`);
    grad.addColorStop(0.7, `rgba(${c[0]},${c[1]},${c[2]},${0.04 * soft})`);
    grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    return cv;
  });
}

/* -------------------------------------------------------------------------- */
/* The renderer                                                               */
/* -------------------------------------------------------------------------- */

export class Starfield {
  private ctx: CanvasRenderingContext2D | null;
  private geo: Geometry;
  private sprites: HTMLCanvasElement[];
  private fills: string[];
  private mode: StarfieldMode = "dark";

  /** CSS pixels. */
  private w = 0;
  private h = 0;
  private dpr = 1;
  private maxDpr: number;

  /** Scene centre in CSS px, and the disc radius in CSS px at s = 1. */
  private ox = 0;
  private oy = 0;
  private unit = 300;

  private zone: ReadingZone | null = null;

  /** Smoothed pointer, -1..1. */
  private curX = 0;
  private curY = 0;
  private tgtX = 0;
  private tgtY = 0;

  private spin = 0;
  /** Seconds of ambient time elapsed; frozen while paused. */
  private clock = 0;

  constructor(canvas: HTMLCanvasElement, tuning: StarfieldTuning) {
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.geo = buildGeometry(tuning.count);
    this.maxDpr = tuning.maxDpr;
    this.sprites = makeSprites(TINTS_DARK, 1);
    this.fills = TINTS_DARK.map(rgb);
  }

  get ok(): boolean {
    return this.ctx !== null;
  }

  setMode(mode: StarfieldMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const tints = mode === "dark" ? TINTS_DARK : TINTS_LIGHT;
    // A dark point on paper needs a far quieter halo, or the arms turn to mud.
    this.sprites = makeSprites(tints, mode === "dark" ? 1 : 0.62);
    this.fills = tints.map(rgb);
  }

  /**
   * Size the drawing buffer from the container's real box. Called on mount and
   * from a ResizeObserver — never from a raw resize event, which misses the
   * container changing for a reason other than the window.
   */
  resize(canvas: HTMLCanvasElement, w: number, h: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.w = w;
    this.h = h;
    canvas.width = Math.max(1, Math.round(w * this.dpr));
    canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.ox = w * 0.5;
    // About 70-80% of the hero width at the widest arm, cropped at the sides
    // and along the bottom edge, which is what gives it scale.
    this.unit = Math.max(w * 0.42, Math.min(w, h) * 0.55);
    this.place();
  }

  setReadingZone(z: ReadingZone | null) {
    this.zone = z;
    this.place();
  }

  /**
   * Put the nucleus BELOW the copy, derived from where the copy actually ends
   * rather than at a fixed fraction of the hero.
   *
   * A fraction was the first version and it is wrong on exactly the viewport
   * that matters most: at 1366x768 the copy runs 200px lower relative to the
   * hero than it does at 1440x900, so a constant 0.81 put the brightest part of
   * the formation directly behind the access-code line. The arms still sweep up
   * across the text — dimmed, which is the point — but the knot clears it.
   */
  private place() {
    const fallback = this.h * (this.w < 720 ? 0.86 : 0.82);
    const z = this.zone;
    this.oy = z
      ? clamp(z.cy + z.hh + this.h * 0.035, this.h * 0.6, this.h * 0.95)
      : fallback;
  }

  /** Store the latest pointer position, normalised. No layout reads here. */
  setPointerTarget(nx: number, ny: number) {
    this.tgtX = clamp(nx, -1, 1);
    this.tgtY = clamp(ny, -1, 1);
  }

  /** Ease back to neutral when the pointer leaves the hero. */
  releasePointer() {
    this.tgtX = 0;
    this.tgtY = 0;
  }

  /** Snap to neutral with no travel — used when motion is switched off. */
  neutralise() {
    this.tgtX = this.tgtY = this.curX = this.curY = 0;
  }

  /**
   * Advance the simulation. `dt` is seconds and is capped by the caller, so a
   * backgrounded tab resuming cannot jump the ambient rotation.
   */
  step(dt: number) {
    const a = 1 - Math.exp(-MOTION.smoothingRate * dt);
    this.curX += (this.tgtX - this.curX) * a;
    this.curY += (this.tgtY - this.curY) * a;
    this.spin += MOTION.spinRate * dt;
    this.clock += dt;
  }

  /** True once the smoothed pointer has effectively reached its target. */
  get settled(): boolean {
    return Math.abs(this.tgtX - this.curX) < 0.0015 && Math.abs(this.tgtY - this.curY) < 0.0015;
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || this.w === 0 || this.h === 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = this.mode === "dark" ? "lighter" : "source-over";

    const yaw = this.curX * MOTION.maxYaw;
    const pitch = -this.curY * MOTION.maxPitch;
    const zone = this.zone;

    // One trig evaluation per rotation per FRAME, not per particle.
    const cs = Math.cos(this.spin), sn = Math.sin(this.spin);
    const ct = Math.cos(TILT), st = Math.sin(TILT);
    const cr = Math.cos(ROLL), sr = Math.sin(ROLL);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);

    // --- the nucleus ------------------------------------------------------
    // A concentration of 1px points is not a concentration: at any honest
    // per-particle alpha the centre reads as slightly-denser dust. The bulge
    // is two pre-rendered sprites drawn once per frame at the projected
    // origin, which is where the density actually is, so it brightens the
    // formation rather than decorating it.
    {
      const bx = this.ox + this.curX * MOTION.travelPx[1];
      const by = this.oy + this.curY * MOTION.travelPx[1] * 0.62;
      const base = (FOCAL / CAM) * this.unit;
      const dim = zone
        ? 0.3 + 0.7 * smoothstep(0.72, 1.24, Math.hypot((bx - zone.cx) / zone.hw, (by - zone.cy) / zone.hh))
        : 1;
      const strength = this.mode === "dark" ? 1 : 0.45;
      const halo = base * 0.5;
      ctx.globalAlpha = 0.1 * dim * strength;
      ctx.drawImage(this.sprites[0], bx - halo, by - halo * 0.72, halo * 2, halo * 1.44);
      const hot = base * 0.17;
      ctx.globalAlpha = 0.24 * dim * strength;
      ctx.drawImage(this.sprites[2], bx - hot, by - hot * 0.8, hot * 2, hot * 1.6);
    }

    const g = this.geo;
    const t = this.clock;
    let tintNow = -1;

    for (let i = 0; i < g.n; i++) {
      // 1. ambient roll about the disc's own axis
      let x = g.x[i] * cs - g.z[i] * sn;
      let z = g.x[i] * sn + g.z[i] * cs;
      let y = g.y[i];

      // 2. fixed rake, so we look ALONG the disc
      const yt = y * ct - z * st;
      z = y * st + z * ct;
      y = yt;

      // 3. roll in the picture plane
      const xr = x * cr - y * sr;
      y = x * sr + y * cr;
      x = xr;

      // 4. pointer yaw (about the world Y axis) and pitch (about world X)
      const xy = x * cyw + z * syw;
      z = -x * syw + z * cyw;
      x = xy;
      const yp = y * cp - z * sp;
      z = y * sp + z * cp;
      y = yp;

      // 5. perspective projection
      const zc = CAM - z;
      if (zc < 0.12) continue;
      const s = FOCAL / zc;

      const travel = MOTION.travelPx[g.layer[i]];
      const sx = this.ox + x * s * this.unit + this.curX * travel;
      const sy = this.oy + y * s * this.unit + this.curY * travel * 0.62;

      // Cheap cull with a margin for the halo.
      if (sx < -60 || sx > this.w + 60 || sy < -60 || sy > this.h + 60) continue;

      // Depth dims and shrinks. `s` at the disc centre is FOCAL / CAM.
      const depth = clamp(s / (FOCAL / CAM), 0.45, 1.9);
      let a = g.alpha[i] * (0.35 + 0.65 * depth);
      // Asynchronous, low-amplitude breathing. Never a twinkle.
      a *= 0.87 + 0.13 * Math.sin(t * g.rate[i] + g.phase[i]);

      if (zone) {
        // Subdue, never erase. The copy block is ~1040x500 CSS px, so a hard
        // exclusion here takes the entire sculpture with it — the reading zone
        // is a dimmer, and the composition keeps the centre quiet by putting
        // the dense part of the formation somewhere else.
        const q = Math.hypot((sx - zone.cx) / zone.hw, (sy - zone.cy) / zone.hh);
        a *= 0.24 + 0.76 * smoothstep(0.72, 1.24, q);
      }
      if (a < 0.012) continue;

      const px = g.size[i] * depth * (this.mode === "dark" ? 1 : 1.05);
      const tint = g.tint[i];
      // Ink on paper needs MORE alpha than light on black, not less: `lighter`
      // accumulates on the dark ground and `source-over` does not.
      ctx.globalAlpha = this.mode === "dark" ? Math.min(a, 1) : Math.min(a * 1.25, 1);

      if (g.halo[i] === 0) {
        if (tint !== tintNow) {
          ctx.fillStyle = this.fills[tint];
          tintNow = tint;
        }
        const d = Math.max(px, 0.7);
        ctx.fillRect(sx - d / 2, sy - d / 2, d, d);
      } else {
        const glint = g.halo[i] === 2;
        const r = px * (glint ? 7 : 4.4);
        ctx.drawImage(this.sprites[tint], sx - r, sy - r, r * 2, r * 2);
        if (glint && this.mode === "dark") {
          // A short cross flare — a handful of these, never the whole field.
          ctx.globalAlpha = Math.min(a * 0.5, 1);
          if (tint !== tintNow) {
            ctx.fillStyle = this.fills[tint];
            tintNow = tint;
          }
          const L = r * 1.5;
          ctx.fillRect(sx - L, sy - 0.3, L * 2, 0.6);
          ctx.fillRect(sx - 0.3, sy - L, 0.6, L * 2);
        }
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}
