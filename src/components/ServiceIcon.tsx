import type { ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  intelligence: <><path d="M5 3h10l4 4v14H5zM14 3v5h5M8 17l3-4 3 2 3-5"/><path d="M8 8h3"/></>,
  "due-diligence": <><path d="M12 3l8 3v5c0 5-4 8-8 10-4-2-8-5-8-10V6z"/><path d="M8 12l3 3 5-6"/></>,
  "deal-origination": <><circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="19" r="2.5"/><path d="M8 6h8M6.5 8.5l4 8M17.5 8.5l-4 8"/></>,
  "market-entry": <><path d="M8 20H4V4h16v4M4 10h5M15 4v5M9 20l11-11M14 9h6v6"/><circle cx="7" cy="17" r="1"/></>,
  "field-research": <><path d="M4 4v16h16M8 15v-4M12 15V7M16 15v-2"/><path d="M17 5h4M19 3v4"/></>,
  optimization: <><path d="M20 10a8 8 0 0 0-14-4L3 9m0-5v5h5M4 14a8 8 0 0 0 14 4l3-3m0 5v-5h-5"/><path d="M9 12l2 2 4-4"/></>,
  infrastructure: <><path d="M3 21V9l9-6 9 6v12M3 21h18M8 21V11h8v10M8 15h8M8 18h8"/></>,
  energy: <path d="M13 2L4 14h7l-1 8 10-13h-7z"/>,
  finance: <><path d="M3 8l9-5 9 5H3zM4 21h16M6 11v7M12 11v7M18 11v7"/></>,
  agriculture: <><path d="M5 20C6 11 12 5 20 4c1 9-3 15-10 15H5zM5 20L16 9M10 15v-5M10 15h5"/></>,
  mining: <><path d="M3 16l5-8 8-3 5 11-8 5zM8 8l5 13M8 8l13 8M16 5l-3 16"/></>,
  property: <><path d="M3 11l9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/></>,
  analytics: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7.5 16v2M12 11v7M16.5 8v10"/></>,
  "data-pipeline": <><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></>,
  forecasting: <><path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></>,
  measurement: <><path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></>,
  automation: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></>,
  insight: <><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5.6 5.6 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6M10 22h4"/></>,
};

export default function ServiceIcon({ name, className = "h-7 w-7" }: { name: string; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.intelligence}</svg>;
}
