"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Pointer effects for elements that opt in with data attributes:
 * `data-fx-tilt` tilts a card in 3D with a moving glare, and `data-fx-glass`
 * gets a specular highlight that follows the pointer. Precise pointers only,
 * and nothing runs for prefers-reduced-motion. Styles live in globals.css.
 */
export default function SiteEffects() {
  const pathname = usePathname();

  useEffect(() => {
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduce) return;

    const cleanups: (() => void)[] = [];
    const wire = (el: HTMLElement, tilt: boolean) => {
      let raf = 0;
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          el.style.setProperty("--fx-mx", `${(x * 100).toFixed(1)}%`);
          el.style.setProperty("--fx-my", `${(y * 100).toFixed(1)}%`);
          if (tilt) {
            el.style.setProperty("--fx-rx", `${((0.5 - y) * 7).toFixed(2)}deg`);
            el.style.setProperty("--fx-ry", `${((x - 0.5) * 7).toFixed(2)}deg`);
          }
        });
      };
      const leave = () => {
        cancelAnimationFrame(raf);
        el.style.removeProperty("--fx-rx");
        el.style.removeProperty("--fx-ry");
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
      cleanups.push(() => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave); });
    };

    document.querySelectorAll<HTMLElement>("[data-fx-tilt]").forEach(el => wire(el, true));
    document.querySelectorAll<HTMLElement>("[data-fx-glass]:not([data-fx-tilt])").forEach(el => wire(el, false));
    return () => cleanups.forEach(fn => fn());
  }, [pathname]);

  return null;
}
