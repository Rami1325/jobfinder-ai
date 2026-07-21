/**
 * CSS-only volumetric "light pillar" (PLAN 12.5e) — layered soft-edged
 * gradient beams standing in for the old WebGL raymarcher (LightPillar):
 * a wide breathing core column plus two narrow swaying wisps read as the
 * same slowly-churning column of light at a glance, without shipping
 * three.js. Styles live in styles.css (.css-pillar*): softness is baked
 * into gradient/mask falloffs (no filter: blur) and the animations touch
 * transform/opacity only, so the whole backdrop stays on the compositor.
 * Brand colors come from the theme tokens (--accent → --mint).
 */
export default function CssPillar() {
  return (
    <div className="css-pillar" aria-hidden>
      <i className="css-pillar-halo" />
      <i className="css-pillar-core" />
      <i className="css-pillar-wisp-a" />
      <i className="css-pillar-wisp-b" />
    </div>
  );
}
