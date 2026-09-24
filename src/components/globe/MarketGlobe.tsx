"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { focusMarkets, projector, toVector } from "./geometry";
import land from "./land-points.json";
import styles from "./MarketGlobe.module.css";

const glyphs = ["₵", "0", "1", "₦", "2", "5", "8", "$", "3", "€"];
const points = land.map(([lon, lat], index) => ({ vector: toVector(lon, lat), glyph: glyphs[index % glyphs.length] }));
const marketPoints = focusMarkets.map(market => ({ ...market, vector: toVector(market.lon, market.lat) }));
// Glyph size and brightness follow depth. Sizes are bucketed so each glyph can
// be drawn once into a sprite and stamped with drawImage: setting a font and
// laying out text for all 1,227 points on every frame was the main cause of the
// homepage's long main-thread tasks on phones.
const SIZE_BUCKETS = [6.4, 7.1, 7.9, 8.6];
const bucketOf = (z: number) => Math.min(SIZE_BUCKETS.length - 1, Math.floor(z * SIZE_BUCKETS.length));

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
    // Phones and touch screens animate at half rate; the motion is ambient.
    const frameMs = 1000 / (window.matchMedia("(max-width: 768px), (pointer: coarse)").matches ? 12 : 24);
    // Motion starts after the page has loaded and gone idle, so it never
    // competes with first paint or the first interaction.
    let started = document.readyState === "complete";
    let sprites = new Map<string, HTMLCanvasElement>();

    function buildSprites() {
      sprites = new Map();
      for (const glyph of glyphs) {
        SIZE_BUCKETS.forEach((size, bucket) => {
          const px = Math.ceil(size * 1.4 * scale) + 2;
          const sprite = document.createElement("canvas");
          sprite.width = px; sprite.height = px;
          const sctx = sprite.getContext("2d");
          if (!sctx) return;
          sctx.font = `${size * scale}px ui-monospace, monospace`;
          sctx.textAlign = "center"; sctx.textBaseline = "middle";
          sctx.fillStyle = "rgb(225,193,125)";
          sctx.fillText(glyph, px / 2, px / 2);
          sprites.set(glyph + bucket, sprite);
        });
      }
    }

    function draw(time: number) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, 600, 560);
      const yaw = 20 + Math.sin(time / 12000) * 9;
      const pitch = 8 + Math.sin(time / 17000) * 2;
      const project = projector(yaw, pitch);
      const sphere = ctx.createRadialGradient(244, 192, 24, 300, 278, 210);
      sphere.addColorStop(0, "#193455"); sphere.addColorStop(.72, "#112744"); sphere.addColorStop(1, "#0c1a35");
      ctx.fillStyle = sphere; ctx.beginPath(); ctx.arc(300, 278, 210, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(147,176,205,.13)"; ctx.lineWidth = .7;
      for (const line of grid) {
        ctx.beginPath(); let pen = false;
        for (const vector of line) {
          const point = project(vector);
          if (point.z < 0) { pen = false; continue; }
          if (pen) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
          pen = true;
        }
        ctx.stroke();
      }
      for (const { vector, glyph } of points) {
        const point = project(vector);
        if (point.z < .04) continue;
        const sprite = sprites.get(glyph + bucketOf(point.z));
        if (!sprite) continue;
        const size = sprite.width / scale;
        ctx.globalAlpha = .15 + point.z * .68;
        ctx.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(212,160,23,.32)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(300, 278, 211, 0, Math.PI * 2); ctx.stroke();
      for (const market of marketPoints) {
        const point = project(market.vector);
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
      if (now - last >= frameMs) {
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
      if (started && !paused && !reduced.matches && !connection?.saveData) frame = requestAnimationFrame(tick);
    }
    function startWhenIdle() {
      const begin = () => { started = true; sync(); };
      if ("requestIdleCallback" in window) window.requestIdleCallback(begin, { timeout: 4000 });
      else setTimeout(begin, 1200);
    }
    if (!started) window.addEventListener("load", startWhenIdle, { once: true });
    function resize() {
      scale = Math.min(window.devicePixelRatio || 1, 1.5) * root!.clientWidth / 600;
      canvas!.width = Math.round(600 * scale); canvas!.height = Math.round(560 * scale);
      buildSprites();
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
      window.removeEventListener("load", startWhenIdle);
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
