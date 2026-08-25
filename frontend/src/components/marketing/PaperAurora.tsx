/**
 * The marketing backdrop: a warm near-white canvas with four very soft,
 * multi-hue blobs bleeding off the viewport edges.
 *
 * It paints `--bg` itself rather than leaning on <body>, because the app's
 * body background is the DARK token — `.paper` only rebinds tokens for its
 * own subtree, so the marketing shell has to lay down its own ground.
 *
 * All styling lives in styles.css (`.paper-aurora*`): softness comes from
 * gradient falloff instead of `filter: blur`, and the slow drift animates
 * transform only, so the whole layer stays on the compositor. Reduced motion
 * is handled by the global media query in styles.css, which parks each blob
 * at a resting position that was designed to look right on its own.
 */
export default function PaperAurora() {
  return (
    <div className="paper-aurora" aria-hidden>
      <i className="paper-aurora-mint" />
      <i className="paper-aurora-violet" />
      <i className="paper-aurora-peach" />
      <i className="paper-aurora-blush" />
    </div>
  );
}
