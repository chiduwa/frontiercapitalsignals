"use client";
import {
  LineChart, Line, BarChart, Bar, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

const gdpData = [
  { year: "2020", Ghana: 2.6, Nigeria: -1.8, Kenya: -0.3, Malawi: 0.9, Uganda: 3.3 },
  { year: "2021", Ghana: 5.4, Nigeria: 3.4, Kenya: 7.5, Malawi: 2.8, Uganda: 3.1 },
  { year: "2022", Ghana: 3.2, Nigeria: 3.3, Kenya: 4.8, Malawi: 0.9, Uganda: 4.7 },
  { year: "2023", Ghana: 2.9, Nigeria: 2.9, Kenya: 5.6, Malawi: 1.5, Uganda: 5.3 },
  { year: "2024", Ghana: 4.7, Nigeria: 3.1, Kenya: 5.1, Malawi: 2.2, Uganda: 6.1 },
];

const fdiData = [
  { country: "Nigeria", fdi: 3.3 },
  { country: "Kenya", fdi: 2.1 },
  { country: "Ghana", fdi: 1.7 },
  { country: "Uganda", fdi: 1.1 },
  { country: "Malawi", fdi: 0.3 },
];

const businessData = [
  { name: "Starting a Biz", Ghana: 72, Nigeria: 55, Kenya: 80, Malawi: 60, Uganda: 65 },
  { name: "Getting Credit", Ghana: 68, Nigeria: 65, Kenya: 75, Malawi: 50, Uganda: 60 },
  { name: "Paying Taxes", Ghana: 58, Nigeria: 48, Kenya: 70, Malawi: 55, Uganda: 62 },
  { name: "Trade", Ghana: 62, Nigeria: 45, Kenya: 68, Malawi: 40, Uganda: 55 },
  { name: "Investor Prot.", Ghana: 70, Nigeria: 62, Kenya: 72, Malawi: 55, Uganda: 60 },
];

const sectorRadar = [
  { sector: "Infrastructure", score: 92 },
  { sector: "Energy", score: 89 },
  { sector: "Fintech", score: 88 },
  { sector: "Agribusiness", score: 85 },
  { sector: "Mining", score: 80 },
  { sector: "Real Estate", score: 76 },
];

const COLORS = {
  Ghana: "#b8860b",
  Nigeria: "#16a34a",
  Kenya: "#2563eb",
  Malawi: "#9333ea",
  Uganda: "#ea580c",
};

const tooltip = {
  contentStyle: { backgroundColor: "#ffffff", border: "1px solid #e5e7eb", borderRadius: 8, color: "#0c1a35", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)" },
  labelStyle: { color: "#b8860b", fontWeight: 700 },
};

export function GDPChart() {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={gdpData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="year" stroke="#cbd5e1" tick={{ fill: "#64748b", fontSize: 12 }} />
        <YAxis stroke="#cbd5e1" tick={{ fill: "#64748b", fontSize: 12 }} unit="%" />
        <Tooltip {...tooltip} formatter={(v) => [`${v}%`]} />
        <Legend wrapperStyle={{ paddingTop: 16, fontSize: 12, color: "#64748b" }} />
        {Object.entries(COLORS).map(([country, color]) => (
          <Line key={country} type="monotone" dataKey={country} stroke={color} strokeWidth={2} dot={{ r: 3, fill: color }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function FDIChart() {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={fdiData} layout="vertical" margin={{ left: 10, right: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
        <XAxis type="number" stroke="#cbd5e1" tick={{ fill: "#64748b", fontSize: 12 }} unit="B" />
        <YAxis type="category" dataKey="country" stroke="#cbd5e1" tick={{ fill: "#64748b", fontSize: 12 }} width={60} />
        <Tooltip {...tooltip} formatter={(v) => [`$${v}B`]} />
        <Bar dataKey="fdi" fill="#b8860b" radius={[0, 4, 4, 0]} name="FDI Inflows (USD)" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BusinessEnvironmentChart() {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={businessData} margin={{ top: 5, right: 20, bottom: 24, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="name" stroke="#cbd5e1" tick={{ fill: "#64748b", fontSize: 10 }} angle={-15} textAnchor="end" interval={0} />
        <YAxis stroke="#cbd5e1" tick={{ fill: "#64748b", fontSize: 12 }} domain={[0, 100]} />
        <Tooltip {...tooltip} />
        <Legend wrapperStyle={{ paddingTop: 16, fontSize: 12, color: "#64748b" }} />
        {Object.entries(COLORS).map(([country, color]) => (
          <Bar key={country} dataKey={country} fill={color} radius={[2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SectorRadarChart() {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <RadarChart data={sectorRadar} cx="50%" cy="50%" outerRadius="70%">
        <PolarGrid stroke="#e5e7eb" />
        <PolarAngleAxis dataKey="sector" tick={{ fill: "#475569", fontSize: 11 }} />
        <Radar name="Opportunity Score" dataKey="score" stroke="#b8860b" fill="#b8860b" fillOpacity={0.15} strokeWidth={2} />
        <Tooltip {...tooltip} />
      </RadarChart>
    </ResponsiveContainer>
  );
}
