"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { focusMarkets, project, toVector } from "./geometry";
import land from "./land-points.json";
import styles from "./MarketGlobe.module.css";

const glyphs = ["₵", "0", "1", "₦", "2", "5", "8", "$", "3", "€"];
const points = land.map(([lon, lat], index) => ({ vector: toVector(lon, lat), glyph: glyphs[index % glyphs.length] }));
const marketPoints = focusMarkets.map(market => ({ ...market, vector: toVector(market.lon, market.lat) }));
const grid = Array.from({ length: 11 }, (_, index) => {
  const latitude = index < 5;
  return Array.from({ length: 121 }, (_, step) => toVector(latitude ? step * 3 - 180 : (index - 5) * 30, latitude ? index * 30 - 60 : step * 1.5 - 90));
});

export default function MarketGlobe() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef("");
  const phaseRef = useRef(0);
  const redrawRef = useRef<(() => void) | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const root = rootRef.current, canvas = canvasRef.current;
    if (!root || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    let frame = 0, visible = false, last = 0, elapsed = phaseRef.current, previous = 0;
    let scale = 1;

    function draw(time: number) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, 600, 560);
      const yaw = 20 + Math.sin(time / 12000) * 9;
      const pitch = 8 + Math.sin(time / 17000) * 2;
      const sphere = ctx.createRadialGradient(244, 192, 24, 300, 278, 210);
      sphere.addColorStop(0, "#193455"); sphere.addColorStop(.72, "#112744"); sphere.addColorStop(1, "#0c1a35");
      ctx.fillStyle = sphere; ctx.beginPath(); ctx.arc(300, 278, 210, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(147,176,205,.13)"; ctx.lineWidth = .7;
      for (const line of grid) {
        ctx.beginPath(); let pen = false;
        for (const vector of line) {
          const point = project(vector, yaw, pitch);
          if (point.z < 0) { pen = false; continue; }
          if (pen) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
          pen = true;
        }
        ctx.stroke();
      }
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const { vector, glyph } of points) {
        const point = project(vector, yaw, pitch);
        if (point.z < .04) continue;
        ctx.font = `${6 + point.z * 3}px ui-monospace, monospace`;
        ctx.fillStyle = `rgba(225,193,125,${.15 + point.z * .68})`;
        ctx.fillText(glyph, point.x, point.y);
      }
      ctx.strokeStyle = "rgba(212,160,23,.32)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(300, 278, 211, 0, Math.PI * 2); ctx.stroke();
      for (const market of marketPoints) {
        const point = project(market.vector, yaw, pitch);
        const selected = activeRef.current === market.name;
        const endX = market.labelX < 300 ? market.labelX + 108 : market.labelX;
        const endY = market.labelY + 22;
        ctx.strokeStyle = selected ? "#f5d58b" : "rgba(220,182,95,.55)";
        ctx.lineWidth = selected ? 1.5 : .8;
        ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo((point.x + endX) / 2, endY); ctx.lineTo(endX, endY); ctx.stroke();
        ctx.fillStyle = "#f5d58b";
        ctx.beginPath(); ctx.arc(point.x, point.y, selected ? 5 : 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(point.x, point.y, selected ? 12 : 8, 0, Math.PI * 2); ctx.stroke();
      }
      root!.dataset.ready = "true";
    }

    function tick(now: number) {
      frame = 0;
      if (now - last >= 1000 / 24) {
        elapsed += previous ? Math.min(now - previous, 100) : 0;
        phaseRef.current = elapsed;
        previous = now; last = now; draw(elapsed);
      }
      frame = requestAnimationFrame(tick);
    }
    function sync() {
      cancelAnimationFrame(frame); frame = 0; previous = 0;
      root!.dataset.motion = reduced.matches || connection?.saveData ? "off" : "on";
      if (!visible || document.hidden) return;
      draw(elapsed);
      if (!paused && !reduced.matches && !connection?.saveData) frame = requestAnimationFrame(tick);
    }
    function resize() {
      scale = Math.min(window.devicePixelRatio || 1, 1.5) * root!.clientWidth / 600;
      canvas!.width = Math.round(600 * scale); canvas!.height = Math.round(560 * scale);
      draw(elapsed);
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: .05 });
    observer.observe(root);
    const sizeObserver = new ResizeObserver(resize); sizeObserver.observe(root);
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    redrawRef.current = () => draw(elapsed);
    resize();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); sizeObserver.disconnect();
      reduced.removeEventListener("change", sync); document.removeEventListener("visibilitychange", sync);
      redrawRef.current = null;
    };
  }, [paused]);

  function highlight(name: string) {
    activeRef.current = name;
    redrawRef.current?.();
  }

  return (
    <figure className={styles.figure} aria-label="Explore FCS's five focus markets">
      <div className={styles.globe} ref={rootRef}>
        <div className={styles.art} aria-hidden="true">
          <Image src="/market-globe.svg" alt="" fill loading="eager" sizes="(max-width: 1023px) 92vw, 600px" className={styles.fallback} />
          <canvas ref={canvasRef} className={styles.canvas} />
        </div>
        <span className={styles.overline}>Local insight. Connected markets.</span>
        {focusMarkets.map(market => (
          <a key={market.name} href={`/resources#${market.name.toLowerCase()}`} className={styles.market}
            style={{ left: `${market.labelX / 6}%`, top: `${market.labelY / 5.6}%` }}
            onPointerEnter={() => highlight(market.name)} onPointerLeave={() => highlight("")}
            onFocus={() => highlight(market.name)} onBlur={() => highlight("")}
            aria-label={`Explore ${market.name} investor resources`}>
            <span>{market.name}</span><small>{market.currency}</small>
          </a>
        ))}
        <button className={styles.motion} type="button" onClick={() => setPaused(value => !value)} aria-pressed={paused}>
          <span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span> {paused ? "Resume globe" : "Pause globe"}
        </button>
      </div>
      <figcaption className={styles.caption}><span className={styles.key} /> Five focus markets <span>Choose a country to explore</span></figcaption>
    </figure>
  );
}
