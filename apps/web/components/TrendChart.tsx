"use client";

/**
 * TrendChart — SMR / Visibility over-time line chart.
 *
 * Renders a Recharts LineChart with dark tokens:
 * - Thin 1.5px lines (brand=cyan, competitor=slate-gray)
 * - 6%-opacity cyan area fill at most
 * - Gridlines at --border
 * - Axis labels 12px muted
 * - No rainbow palette, no 3D, no gradient fills
 *
 * Data comes from report_snapshot history (O(snapshots), no live recompute).
 */

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";

/** One data point in the trend series. */
export interface TrendPoint {
  /** ISO date string for the x-axis label (week_start). */
  weekStart: string;
  /** SMR value [0,1] */
  smr?: number;
  /** Visibility value [0,1] */
  visibility?: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  /** Which series to show. Default: ["smr"] */
  series?: Array<"smr" | "visibility">;
  /** Chart height in px. Default: 220. */
  height?: number;
}

const SERIES_CONFIG = {
  smr: {
    key: "smr" as const,
    label: "SMR",
    color: "#22D3EE", // --accent cyan
    fillOpacity: 0.06,
  },
  visibility: {
    key: "visibility" as const,
    label: "Visibility",
    color: "#64748B", // slate-gray for secondary metric
    fillOpacity: 0.03,
  },
};

function formatWeek(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return iso;
  }
}

function formatPct(v: number | undefined): string {
  if (v === undefined || v === null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function TrendChart({
  data,
  series = ["smr"],
  height = 220,
}: TrendChartProps) {
  if (!data || data.length === 0) {
    return (
      <div
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: "var(--text-caption-size)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-card)",
        }}
      >
        데이터 없음 — 첫 주간 리포트 생성 후 트렌드가 표시됩니다.
      </div>
    );
  }

  const formattedData = data.map((d) => ({
    ...d,
    _label: formatWeek(d.weekStart),
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={formattedData}
        margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
      >
        <defs>
          {series.map((s) => {
            const cfg = SERIES_CONFIG[s];
            return (
              <linearGradient
                key={s}
                id={`fill-${s}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={cfg.color}
                  stopOpacity={cfg.fillOpacity}
                />
                <stop offset="95%" stopColor={cfg.color} stopOpacity={0} />
              </linearGradient>
            );
          })}
        </defs>

        <CartesianGrid
          strokeDasharray="2 4"
          stroke="#1E2A44"
          vertical={false}
        />

        <XAxis
          dataKey="_label"
          tick={{ fill: "#93A0B8", fontSize: 12 }}
          axisLine={{ stroke: "#1E2A44" }}
          tickLine={false}
        />

        <YAxis
          tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
          tick={{ fill: "#93A0B8", fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          domain={[0, "auto"]}
          width={40}
        />

        <Tooltip
          contentStyle={{
            backgroundColor: "#121A2E",
            border: "1px solid #1E2A44",
            borderRadius: "6px",
            fontSize: "13px",
            color: "#E6EAF2",
          }}
          formatter={(value: number, name: string) => [
            formatPct(value),
            name === "smr" ? "SMR" : "Visibility",
          ]}
          labelFormatter={(label: string) => `주 ${label}`}
        />

        {series.map((s) => {
          const cfg = SERIES_CONFIG[s];
          return (
            <Area
              key={s}
              type="monotone"
              dataKey={cfg.key}
              stroke={cfg.color}
              strokeWidth={1.5}
              fill={`url(#fill-${s})`}
              dot={false}
              activeDot={{ r: 3, fill: cfg.color, strokeWidth: 0 }}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}
