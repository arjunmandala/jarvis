// Self-contained HTML dashboard for run telemetry. Zero external requests:
// inline CSS + SVG, one inline <script> for tooltips. Colors are the dataviz
// reference palette (pre-validated for CVD + contrast); marks follow its specs —
// bars ≤24px with a 4px rounded data-end (square at the baseline), 2px lines,
// dots ringed in the surface color, hairline grid, text in ink tokens.
import type { ReportData, RunRow } from "./data.ts";
import { percentile, cacheHitRate, approvalDwellsMs, createdToPrMs } from "./data.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const fmtUsd = (v: number): string => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

function fmtMs(ms: number | null): string {
  if (ms == null) return "–";
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const fmtPct = (v: number | null): string => (v == null ? "–" : `${Math.round(v * 100)}%`);

// Shared horizontal-bar geometry.
const W = 660, LABEL_W = 120, VALUE_W = 100, ROW_H = 30, BAR_H = 18;
const EMPTY = `<p class="empty">no data yet</p>`;

interface BarRow { label: string; value: number; text: string; tip: string; }

// Single-series horizontal bars: 4px rounded data-end, square at the baseline.
function barSvg(rows: BarRow[], max?: number): string {
  if (rows.length === 0) return EMPTY;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1e-9);
  const span = W - LABEL_W - VALUE_W;
  const bars = rows
    .map((r, i) => {
      const w = Math.max(4, (span * r.value) / top);
      const y = i * ROW_H + (ROW_H - BAR_H) / 2;
      return (
        `<g class="hit" data-tip="${esc(r.tip)}">` +
        `<rect x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}" fill="transparent"/>` +
        `<text x="${LABEL_W - 8}" y="${y + BAR_H / 2}" text-anchor="end" dominant-baseline="central" class="lbl">${esc(r.label)}</text>` +
        `<path d="M${LABEL_W} ${y}h${w - 4}a4 4 0 0 1 4 4v${BAR_H - 8}a4 4 0 0 1-4 4h${4 - w}z" fill="var(--series-1)"/>` +
        `<text x="${LABEL_W + w + 8}" y="${y + BAR_H / 2}" dominant-baseline="central" class="val">${esc(r.text)}</text>` +
        `</g>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${rows.length * ROW_H}" width="100%" role="img">${bars}</svg>`;
}

const BUCKETS = [
  { key: "success", label: "success", color: "var(--good)" },
  { key: "interrupted", label: "interrupted / no result", color: "var(--warn)" },
  { key: "failed", label: "failed", color: "var(--crit)" },
] as const;
type BucketKey = (typeof BUCKETS)[number]["key"];

function outcomeBucket(outcome: string | null): BucketKey {
  if (outcome === "success") return "success";
  if (outcome == null || outcome === "interrupted" || outcome === "no_result") return "interrupted";
  return "failed";
}

// Stacked outcome bars per task type; 2px surface gaps between segments.
function stackedOutcomes(runs: RunRow[]): string {
  const types = [...new Set(runs.map((r) => r.taskType))];
  if (types.length === 0) return EMPTY;
  const counts = new Map<string, Record<BucketKey, number>>();
  for (const r of runs) {
    const c = counts.get(r.taskType) ?? { success: 0, interrupted: 0, failed: 0 };
    c[outcomeBucket(r.outcome)] += 1;
    counts.set(r.taskType, c);
  }
  const maxN = Math.max(...types.map((t) => runs.filter((r) => r.taskType === t).length));
  const span = W - LABEL_W - VALUE_W;
  const rows = types
    .map((t, i) => {
      const c = counts.get(t)!;
      const total = c.success + c.interrupted + c.failed;
      const y = i * ROW_H + (ROW_H - BAR_H) / 2;
      let x = LABEL_W;
      const present = BUCKETS.filter((b) => c[b.key] > 0);
      const segs = present
        .map((b, j) => {
          const gap = j < present.length - 1 ? 2 : 0;
          const w = Math.max(2, (span * c[b.key]) / maxN - gap);
          const last = j === present.length - 1;
          const seg = last
            ? `<path d="M${x} ${y}h${Math.max(w, 4) - 4}a4 4 0 0 1 4 4v${BAR_H - 8}a4 4 0 0 1-4 4h${4 - Math.max(w, 4)}z" fill="${b.color}"/>`
            : `<rect x="${x}" y="${y}" width="${w}" height="${BAR_H}" fill="${b.color}"/>`;
          x += w + gap;
          return seg;
        })
        .join("");
      return (
        `<g class="hit" data-tip="${esc(`${t}: ${c.success} success · ${c.interrupted} interrupted · ${c.failed} failed`)}">` +
        `<rect x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}" fill="transparent"/>` +
        `<text x="${LABEL_W - 8}" y="${y + BAR_H / 2}" text-anchor="end" dominant-baseline="central" class="lbl">${esc(t)}</text>` +
        segs +
        `<text x="${x + 6}" y="${y + BAR_H / 2}" dominant-baseline="central" class="val">${total}</text>` +
        `</g>`
      );
    })
    .join("");
  const legend =
    `<div class="legend">` +
    BUCKETS.map((b) => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join("") +
    `</div>`;
  return legend + `<svg viewBox="0 0 ${W} ${types.length * ROW_H}" width="100%" role="img">${rows}</svg>`;
}

// Dumbbell: p50 (solid dot) → p90 (faded dot) per task type, 2px connector.
function durationChart(runs: RunRow[]): string {
  const types = [...new Set(runs.filter((r) => r.durationMs != null).map((r) => r.taskType))];
  if (types.length === 0) return EMPTY;
  const stats = types.map((t) => {
    const ds = runs.filter((r) => r.taskType === t && r.durationMs != null).map((r) => r.durationMs!);
    return { label: t, p50: percentile(ds, 50)!, p90: percentile(ds, 90)! };
  });
  const max = Math.max(...stats.map((s) => s.p90), 1);
  const span = W - LABEL_W - VALUE_W;
  const rows = stats
    .map((s, i) => {
      const y = i * ROW_H + ROW_H / 2;
      const x50 = LABEL_W + (span * s.p50) / max;
      const x90 = LABEL_W + (span * s.p90) / max;
      return (
        `<g class="hit" data-tip="${esc(`${s.label}: p50 ${fmtMs(s.p50)} · p90 ${fmtMs(s.p90)}`)}">` +
        `<rect x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}" fill="transparent"/>` +
        `<text x="${LABEL_W - 8}" y="${y}" text-anchor="end" dominant-baseline="central" class="lbl">${esc(s.label)}</text>` +
        `<line x1="${x50}" y1="${y}" x2="${x90}" y2="${y}" stroke="var(--series-1)" stroke-width="2"/>` +
        `<circle cx="${x50}" cy="${y}" r="5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>` +
        `<circle cx="${x90}" cy="${y}" r="5" fill="var(--series-1)" fill-opacity="0.55" stroke="var(--surface-1)" stroke-width="2"/>` +
        `<text x="${x90 + 10}" y="${y}" dominant-baseline="central" class="val">${fmtMs(s.p50)} / ${fmtMs(s.p90)}</text>` +
        `</g>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${stats.length * ROW_H}" width="100%" role="img">${rows}</svg>`;
}

// Daily total cost: 2px line, 10% area wash, ringed end-dot, per-day hover.
function costOverTime(runs: RunRow[]): string {
  const byDay = new Map<string, number>();
  for (const r of runs) {
    if (r.costUsd == null) continue;
    const day = r.startedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.costUsd);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (days.length === 0) return EMPTY;
  const H = 180, PAD_L = 52, PAD_R = 20, PAD_T = 14, PAD_B = 24;
  const rawMax = Math.max(...days.map(([, v]) => v));
  const max = rawMax * 1.1 || 1;
  const x = (i: number) => PAD_L + ((W - PAD_L - PAD_R) * i) / Math.max(days.length - 1, 1);
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / max);
  const pts = days.map(([, v], i) => `${x(i)},${y(v)}`).join(" ");
  const grid = [rawMax / 2, rawMax]
    .map(
      (v) =>
        `<line x1="${PAD_L}" y1="${y(v)}" x2="${W - PAD_R}" y2="${y(v)}" class="grid"/>` +
        `<text x="${PAD_L - 6}" y="${y(v)}" text-anchor="end" dominant-baseline="central" class="tick">${fmtUsd(v)}</text>`,
    )
    .join("");
  const area = `<polygon points="${x(0)},${y(0)} ${pts} ${x(days.length - 1)},${y(0)}" fill="var(--series-1)" fill-opacity="0.1"/>`;
  const line =
    days.length === 1
      ? ""
      : `<polyline points="${pts}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const last = days[days.length - 1];
  const endDot = `<circle cx="${x(days.length - 1)}" cy="${y(last[1])}" r="4.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>`;
  const endLbl = `<text x="${x(days.length - 1) - 8}" y="${y(last[1]) - 10}" text-anchor="end" class="val">${fmtUsd(last[1])}</text>`;
  const cellW = (W - PAD_L - PAD_R) / Math.max(days.length - 1, 1);
  const hovers = days
    .map(
      ([day, v], i) =>
        `<rect class="hit" data-tip="${esc(`${day}: ${fmtUsd(v)}`)}" x="${x(i) - cellW / 2}" y="0" width="${cellW}" height="${H}" fill="transparent"/>`,
    )
    .join("");
  const xLabels =
    `<text x="${PAD_L}" y="${H - 6}" class="tick">${days[0][0]}</text>` +
    `<text x="${W - PAD_R}" y="${H - 6}" text-anchor="end" class="tick">${last[0]}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${grid}${area}${line}${endDot}${endLbl}${hovers}${xLabels}</svg>`;
}

function modelTable(runs: RunRow[]): string {
  const models = [...new Set(runs.filter((r) => r.model != null && r.outcome != null).map((r) => r.model!))];
  if (models.length === 0) return `<p class="empty">no model data yet (recorded from this release on)</p>`;
  const rows = models
    .map((m) => {
      const rs = runs.filter((r) => r.model === m && r.outcome != null);
      const ok = rs.filter((r) => r.outcome === "success").length;
      const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return `<tr><td>${esc(m)}</td><td>${rs.length}</td><td>${fmtPct(ok / rs.length)}</td><td>${fmtUsd(cost / rs.length)}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>model</th><th>runs</th><th>success</th><th>$/run</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function runsTable(runs: RunRow[]): string {
  const latest = [...runs].sort((a, b) => b.id - a.id).slice(0, 50);
  if (latest.length === 0) return EMPTY;
  const rows = latest
    .map(
      (r) =>
        `<tr><td>${r.id}</td><td>${esc(r.taskType)}</td><td>${esc(r.model ?? "–")}</td>` +
        `<td>${esc(r.outcome ?? "open")}</td><td>${fmtMs(r.durationMs)}</td><td>${r.numTurns ?? "–"}</td>` +
        `<td>${r.costUsd != null ? fmtUsd(r.costUsd) : "–"}</td><td>${fmtPct(cacheHitRate(r.cacheRead, r.cacheWrite))}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>id</th><th>task</th><th>model</th><th>outcome</th><th>duration</th><th>turns</th><th>cost</th><th>cache hit</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function failuresSection(d: ReportData): string {
  const groups = d.failureGroups.length
    ? `<ul class="fails">${d.failureGroups.map((g) => `<li><b>${g.n}×</b> ${esc(g.key)}</li>`).join("")}</ul>`
    : `<p class="empty">no failed tool results recorded</p>`;
  const tails = d.failedRuns
    .map(
      (r) =>
        `<details><summary>run ${r.id} [${esc(r.taskType)}] ${esc(r.outcome)}${r.error ? ` — ${esc(r.error.slice(0, 120))}` : ""}</summary>` +
        `<pre>${esc(r.lastEvents.map((e) => `${e.ts} ${e.type} ${e.payload.slice(0, 300)}`).join("\n")) || "(no events)"}</pre></details>`,
    )
    .join("");
  return groups + tails;
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; }
body {
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--page); color: var(--ink); padding: 24px; max-width: 760px; margin: 0 auto;
  --page: #f9f9f7; --surface-1: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --gridline: #e1e0d9; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --good: #0ca30c; --warn: #fab219; --crit: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  body {
    --page: #0d0d0d; --surface-1: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --gridline: #2c2c2a; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
  }
}
h1 { font-size: 20px; }
.sub { color: var(--muted); margin: 4px 0 20px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; flex: 1 1 120px; }
.tile-label { color: var(--ink-2); font-size: 12px; }
.tile-value { font-size: 26px; font-weight: 600; margin-top: 2px; }
section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
h2 { font-size: 14px; margin-bottom: 2px; }
.caption { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
svg { display: block; }
.lbl { fill: var(--ink-2); font-size: 12px; }
.val { fill: var(--ink); font-size: 12px; }
.tick { fill: var(--muted); font-size: 11px; }
.grid { stroke: var(--gridline); stroke-width: 1; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--gridline); }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
.empty { color: var(--muted); }
.fails { list-style: none; }
.fails li { padding: 2px 0; }
details { margin-top: 8px; }
summary { cursor: pointer; }
pre { overflow-x: auto; background: var(--page); padding: 8px; border-radius: 6px; font-size: 12px; margin-top: 6px; }
#tip { position: absolute; display: none; background: var(--ink); color: var(--page); padding: 4px 8px; border-radius: 6px; font-size: 12px; pointer-events: none; max-width: 360px; z-index: 10; }
`;

function tile(label: string, value: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div></div>`;
}

export function renderHtml(d: ReportData): string {
  const totalCost = d.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const impl = d.runs.filter((r) => r.taskType === "implement" && r.outcome != null);
  const implRate = impl.length ? impl.filter((r) => r.outcome === "success").length / impl.length : null;
  const dwell = percentile(approvalDwellsMs(d.phaseEvents), 50);
  const e2e = percentile(createdToPrMs(d.phaseEvents, d.sessionsWithPr), 50);

  const types = [...new Set(d.runs.map((r) => r.taskType))];
  const costRows: BarRow[] = types
    .map((t) => {
      const cost = d.runs.filter((r) => r.taskType === t).reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return { label: t, value: cost, text: fmtUsd(cost), tip: `${t}: ${fmtUsd(cost)} total` };
    })
    .sort((a, b) => b.value - a.value);

  const timingLabels = [...new Set(d.timings.map((t) => t.label))];
  const timingRows: BarRow[] = timingLabels
    .map((l) => {
      const ms = d.timings.filter((t) => t.label === l).map((t) => t.ms);
      const p50 = percentile(ms, 50)!;
      return {
        label: l, value: p50, text: fmtMs(p50),
        tip: `${l}: p50 ${fmtMs(p50)} · p90 ${fmtMs(percentile(ms, 90))} · n=${ms.length}`,
      };
    })
    .sort((a, b) => b.value - a.value);

  const cacheRows: BarRow[] = types.flatMap((t) => {
    const rs = d.runs.filter((r) => r.taskType === t);
    const rate = cacheHitRate(
      rs.reduce((s, r) => s + r.cacheRead, 0),
      rs.reduce((s, r) => s + r.cacheWrite, 0),
    );
    return rate == null ? [] : [{ label: t, value: rate, text: fmtPct(rate), tip: `${t}: ${fmtPct(rate)} cache hit` }];
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis telemetry</title>
<style>${CSS}</style>
</head>
<body>
<h1>Jarvis telemetry</h1>
<p class="sub">generated ${esc(d.generatedAt)} · ${d.runs.length} runs</p>
<div class="tiles">
${tile("Total spend", fmtUsd(totalCost))}
${tile("Runs", String(d.runs.length))}
${tile("Implement success", fmtPct(implRate))}
${tile("Median approval wait", fmtMs(dwell))}
${tile("Median created→PR", fmtMs(e2e))}
</div>
<section><h2>Cost by task type</h2><p class="caption">total $ per task type</p>${barSvg(costRows)}</section>
<section><h2>Outcomes by task type</h2><p class="caption">runs per outcome bucket</p>${stackedOutcomes(d.runs)}</section>
<section><h2>Run duration</h2><p class="caption">solid dot = p50, faded dot = p90</p>${durationChart(d.runs)}</section>
<section><h2>Host timings</h2><p class="caption">median wall-clock per sandbox lifecycle step</p>${barSvg(timingRows)}</section>
<section><h2>Cache hit rate</h2><p class="caption">cache reads / (reads + writes) per task type</p>${barSvg(cacheRows, 1)}</section>
<section><h2>Cost over time</h2><p class="caption">$ per day, all task types</p>${costOverTime(d.runs)}</section>
<section><h2>By model</h2><p class="caption">implement routing outcomes</p>${modelTable(d.runs)}</section>
<section><h2>Recent failures</h2>${failuresSection(d)}</section>
<section><h2>Runs</h2><p class="caption">latest 50</p>${runsTable(d.runs)}</section>
<div id="tip"></div>
<script>
const tip = document.getElementById("tip");
for (const el of document.querySelectorAll(".hit")) {
  el.addEventListener("mousemove", (e) => {
    tip.textContent = el.dataset.tip;
    tip.style.display = "block";
    tip.style.left = e.pageX + 12 + "px";
    tip.style.top = e.pageY + 12 + "px";
  });
  el.addEventListener("mouseleave", () => (tip.style.display = "none"));
}
</script>
</body>
</html>`;
}
