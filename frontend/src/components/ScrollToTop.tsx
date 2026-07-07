import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Reset scroll to the top on every route change. The app uses BrowserRouter
 * (not a data router), which doesn't restore/reset scroll on its own — so
 * jumping from a scrolled page to another would otherwise keep the previous
 * offset and land you mid-page. Hash-only changes (marketing anchors) don't
 * change the pathname, so in-page anchor links still work.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}
