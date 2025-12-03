import React, { useEffect, useMemo, useState } from "react";
import supabase from "../lib/supabaseClient";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

// Robust year extractor for date strings; falls back to regex if Date parsing fails
const extractYear = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.getFullYear();
  const match = String(value).match(/(\d{4})/);
  return match ? Number(match[1]) : null;
};

// Shared transformer: group already-filtered rows by PO and return chart-ready data + risk summary
export function transformRowsToPOLevel(filteredRows) {
  const filtered = filteredRows.filter((r) => {
    const yr = extractYear(r.po_creation_date);
    if (yr !== null && yr > 2025) return false;
    return true;
  });

  const groups = new Map();
  filtered.forEach((r, idx) => {
    const key = r.po_number || `po-${idx}`;
    if (!groups.has(key)) {
      groups.set(key, {
        po_number: key,
        po_creation_date: r.po_creation_date || null,
        total_cost: 0,
        lead_time_days_sum: 0,
        lead_time_days_count: 0,
        defect_quantity: 0,
        produced_quantity: 0,
        good_pieces: 0,
        oee_pct_sum: 0,
        oee_pct_count: 0,
        risk_score: r.risk_score !== null && r.risk_score !== undefined ? Number(r.risk_score) : null,
        risk_level: r.risk_level || null,
      });
    }
    const g = groups.get(key);

    const cost = Number(r.total_cost);
    if (!Number.isNaN(cost)) g.total_cost += cost;

    const ltd = Number(r.lead_time_days);
    if (!Number.isNaN(ltd)) {
      g.lead_time_days_sum += ltd;
      g.lead_time_days_count += 1;
    }

    const defect = Number(r.defect_quantity);
    if (!Number.isNaN(defect)) g.defect_quantity += defect;

    const produced = Number(r.produced_quantity);
    if (!Number.isNaN(produced)) g.produced_quantity += produced;

    const good = Number(r.good_pieces);
    if (!Number.isNaN(good)) g.good_pieces += good;

    const oee = Number(r.oee_pct);
    if (!Number.isNaN(oee)) {
      g.oee_pct_sum += oee;
      g.oee_pct_count += 1;
    }

    // Keep highest risk_score and its level if multiple rows
    const rowRisk = r.risk_score !== null && r.risk_score !== undefined ? Number(r.risk_score) : null;
    if (rowRisk !== null && (g.risk_score === null || rowRisk > g.risk_score)) {
      g.risk_score = rowRisk;
      g.risk_level = r.risk_level || g.risk_level;
    }
  });

  const poLevelData = Array.from(groups.values())
    .map((g) => ({
      po_number: g.po_number,
      po_creation_date: g.po_creation_date,
      total_cost: g.total_cost,
      lead_time_days:
        g.lead_time_days_count > 0 ? g.lead_time_days_sum / g.lead_time_days_count : null,
      defect_quantity: g.defect_quantity,
      produced_quantity: g.produced_quantity,
      good_pieces: g.good_pieces,
      oee_pct: g.oee_pct_count > 0 ? g.oee_pct_sum / g.oee_pct_count : null,
      risk_score: g.risk_score,
      risk_level: g.risk_level,
    }))
    // Exclude future/irrelevant year 2026+ from the chart (based on po_creation_date)
    .filter((g) => {
      const yr = extractYear(g.po_creation_date);
      if (yr === null) return true;
      return yr <= 2025;
    })
    .sort((a, b) => {
      const da = a.po_creation_date ? new Date(a.po_creation_date).getTime() : Infinity;
      const db = b.po_creation_date ? new Date(b.po_creation_date).getTime() : Infinity;
      return da - db;
    });

  // Risk summary: highest risk_score/level
  let riskScore = null;
  let riskLevel = "No Data";
  if (poLevelData.length) {
    poLevelData.forEach((p) => {
      if (p.risk_score !== null && p.risk_score !== undefined) {
        if (riskScore === null || p.risk_score > riskScore) {
          riskScore = p.risk_score;
          riskLevel = p.risk_level || "No Data";
        }
      }
    });
    if (riskScore === null) riskLevel = "No Data";
  }

  return { poLevelData, riskSummary: { riskScore, riskLevel } };
}

// Risk summarizer based on distribution, not max-only
export function summarizeRisk(poLines) {
  if (!poLines || poLines.length === 0) {
    return {
      n_pos: 0,
      safe_count: 0,
      medium_count: 0,
      high_count: 0,
      high_pct: 0,
      avg_risk_score: null,
      overall_level: "No Data",
    };
  }

  const n_pos = poLines.length;
  let safe = 0;
  let med = 0;
  let high = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  poLines.forEach((p) => {
    if (p.risk_level === "Safe") safe += 1;
    else if (p.risk_level === "Medium Risk") med += 1;
    else if (p.risk_level === "High Risk") high += 1;

    if (p.risk_score !== null && p.risk_score !== undefined && !Number.isNaN(p.risk_score)) {
      scoreSum += Number(p.risk_score);
      scoreCount += 1;
    }
  });

  const high_pct = n_pos > 0 ? high / n_pos : 0;
  const avg_risk_score = scoreCount > 0 ? scoreSum / scoreCount : null;

  let overall_level = "Need More Data";
  if (n_pos < 3) {
    overall_level = "Need More Data";
  } else if (high_pct >= 0.5 && (avg_risk_score ?? 0) >= 10) {
    overall_level = "High Risk";
  } else if (high_pct >= 0.2 || (avg_risk_score ?? 0) >= 6) {
    overall_level = "Medium Risk";
  } else {
    overall_level = "Safe";
  }

  return {
    n_pos,
    safe_count: safe,
    medium_count: med,
    high_count: high,
    high_pct,
    avg_risk_score,
    overall_level,
  };
}

function IntegratedDashboard({ onBack }) {
  const [rows, setRows] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  // Force a customer selection to avoid loading every PO; will auto-populate after fetch
  const [filters, setFilters] = useState({
    customer: "",
    part: "All",
    supplier: "All",
  });

  useEffect(() => {
    const loadData = async () => {
      setDataLoading(true);
      setDataError(null);
      try {
        const chunkSize = 5000;
        let offset = 0;
        let aggregated = [];
        while (true) {
          const { data, error } = await supabase
            .schema("crm")
            .from("crm_erp_funnel_view")
            .select(
              [
                "customer_name",
                "part_name",
                "supplier_name",
                "po_number",
                "po_creation_date",
                "total_cost",
                "lead_time_days",
                "defect_quantity",
                "produced_quantity",
                "good_pieces",
                "oee_pct",
                "risk_score",
                "risk_level",
              ].join(", ")
            )
            .range(offset, offset + chunkSize - 1);

          if (error) throw error;
          const batch = data || [];
          aggregated = aggregated.concat(batch);
          if (batch.length < chunkSize) break;
          offset += chunkSize;
        }
        setRows(aggregated);
      } catch (err) {
        console.error(err);
        setDataError(err.message ?? "Failed to load data");
      } finally {
        setDataLoading(false);
      }
    };
    loadData();
  }, []);

  // Build cascading options and filtered data
  const { customerOptions, partOptions, supplierOptions, poLevelData, riskSummary } = useMemo(() => {
    const norm = (v) => (v === null || v === undefined ? null : String(v).trim());
    const eqi = (a, b) => {
      if (a === null || a === undefined || b === null || b === undefined) return false;
      return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    };

    const customerOptions = Array.from(
      new Set(rows.map((r) => norm(r.customer_name)).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    const customerFiltered =
      !filters.customer
        ? rows
        : rows.filter((r) => eqi(r.customer_name, filters.customer));

    const partOptions = Array.from(
      new Set(customerFiltered.map((r) => norm(r.part_name)).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    let supplierSource = customerFiltered;
    if (filters.part !== "All") {
      supplierSource = supplierSource.filter((r) => eqi(r.part_name, filters.part));
    }
    const supplierOptions = Array.from(
      new Set(supplierSource.map((r) => norm(r.supplier_name)).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    // Apply filters: customer required, part/supplier optional ("All")
    const filteredRows = rows.filter((r) => {
      if (!filters.customer) return false;
      if (!eqi(r.customer_name, filters.customer)) return false;
      if (filters.part !== "All" && !eqi(r.part_name, filters.part)) return false;
      if (filters.supplier !== "All" && !eqi(r.supplier_name, filters.supplier)) return false;
      return true;
    });

    const { poLevelData, riskSummary } = transformRowsToPOLevel(filteredRows);

    return {
      customerOptions,
      partOptions,
      supplierOptions,
      poLevelData,
      riskSummary,
    };
  }, [rows, filters]);

  // Final chart dataset: keep only rows with a valid year <= 2025
  const chartData = useMemo(() => {
    return poLevelData.filter((p) => {
      const yr = extractYear(p.po_creation_date);
      return yr !== null && yr <= 2025;
    });
  }, [poLevelData]);

  // Auto-select first customer option once available
  useEffect(() => {
    if (!filters.customer && customerOptions.length > 0) {
      setFilters((prev) => ({
        ...prev,
        customer: customerOptions[0],
        part: "All",
        supplier: "All",
      }));
    }
    // If current customer is no longer available, fall back to first option
    if (filters.customer && customerOptions.length > 0 && !customerOptions.includes(filters.customer)) {
      setFilters((prev) => ({
        ...prev,
        customer: customerOptions[0],
        part: "All",
        supplier: "All",
      }));
    }
  }, [customerOptions, filters.customer]);

  const riskColor =
    riskSummary.riskLevel === "High Risk"
      ? "text-red-300"
      : riskSummary.riskLevel === "Medium Risk"
      ? "text-yellow-300"
      : riskSummary.riskLevel === "Safe"
      ? "text-emerald-300"
      : "text-emerald-100";

  const canShowRisk = Boolean(filters.customer) && filters.part !== "All" && filters.supplier !== "All";
  const distribution = useMemo(() => (canShowRisk ? summarizeRisk(poLevelData) : null), [canShowRisk, poLevelData]);

  // Reset dependent filters if invalid
  useEffect(() => {
    if (filters.part !== "All" && !partOptions.includes(filters.part)) {
      setFilters((prev) => ({ ...prev, part: "All", supplier: "All" }));
    }
  }, [partOptions, filters.part]);

  useEffect(() => {
    if (filters.supplier !== "All" && !supplierOptions.includes(filters.supplier)) {
      setFilters((prev) => ({ ...prev, supplier: "All" }));
    }
  }, [supplierOptions, filters.supplier]);

  return (
    <section className="max-w-7xl mx-auto mt-10 pt-2 pb-16 min-h-screen">
      <div className="rounded-3xl border border-emerald-500/40 bg-gradient-to-b from-emerald-900 via-emerald-800 to-emerald-900 px-5 py-6 shadow-emerald-900/40 shadow-2xl md:px-8 md:py-8">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 text-sm text-emerald-100 hover:text-emerald-50
                       border border-emerald-400/40 rounded-full px-3 py-1 bg-emerald-900/40
                       hover:bg-emerald-800/60 transition"
          >
            <span className="text-lg leading-none">←</span>
            <span>Back to dashboard</span>
          </button>

          <div className="text-xs text-emerald-100/70">
            Home / Integrated Analytics
          </div>
        </div>

        <div className="mt-6">
          <p className="inline-flex items-center gap-2 rounded-full bg-emerald-900/60 border border-emerald-400/40 px-4 py-1 text-xs text-emerald-100">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            CRM &amp; ERP Integration
          </p>
          <h2 className="mt-3 text-2xl md:text-3xl font-bold text-white tracking-tight">
            Cross-System Cost, Cycle &amp; Quality KPIs
          </h2>
          <p className="mt-2 text-sm text-emerald-100/80 max-w-2xl">
            Track PO-level cost, lead time, defects, OEE, and risk with synchronized customer, part, and supplier filters.
          </p>
        </div>

        {dataError && (
          <p className="mt-4 text-xs text-red-200">
            Failed to load data: {dataError}
          </p>
        )}

        {/* Filters */}
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Customer</label>
            <select
              value={filters.customer}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  customer: e.target.value,
                  part: "All",
                  supplier: "All",
                }))
              }
              className="bg-[#050908]/70 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            >
              {customerOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Part</label>
            <select
              value={filters.part}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  part: e.target.value,
                  supplier: "All",
                }))
              }
              className="bg-[#050908]/70 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            >
              <option value="All">All</option>
              {partOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Vendor</label>
            <select
              value={filters.supplier}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  supplier: e.target.value,
                }))
              }
              className="bg-[#050908]/70 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            >
              <option value="All">All</option>
              {supplierOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Risk card */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Risk Summary</h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                Based on risk_score and risk_level provided by the integrated data.
              </p>
            </div>
          </div>
          {!canShowRisk ? (
            <div className="text-xs text-emerald-100/70 mt-2">
              Select customer, part, and vendor to see risk.
            </div>
          ) : !distribution ? (
            <div className="text-xs text-emerald-100/70 mt-2">No data for this selection.</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-4 mt-4 text-sm text-emerald-50">
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">Overall</div>
                <div className={`text-xl font-bold ${riskColor}`}>
                  {distribution.overall_level}
                </div>
                <div className="text-xs text-emerald-100/70">
                  Avg score: {distribution.avg_risk_score !== null ? distribution.avg_risk_score.toFixed(1) : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">Safe</div>
                <div className="text-lg font-semibold text-emerald-200">
                  {distribution.safe_count}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">Medium</div>
                <div className="text-lg font-semibold text-yellow-300">
                  {distribution.medium_count}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">High</div>
                <div className="text-lg font-semibold text-red-300">
                  {distribution.high_count} ({(distribution.high_pct * 100).toFixed(1)}%)
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Multi-line trend chart */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Process Trend by PO</h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                PO-level lines for cost, lead time, defects, and OEE.
              </p>
            </div>
          </div>

          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">Failed to load data: {dataError}</div>
          ) : !chartData.length ? (
            <div className="text-xs text-emerald-100/70">No data for this selection.</div>
          ) : (
            <div className="w-full" style={{ height: 340 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(16,185,129,0.18)" />
                  <XAxis
                    dataKey="po_creation_date"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    angle={-20}
                    height={50}
                  />
                  <YAxis tick={{ fontSize: 11, fill: "#A7F3D0" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#022c22",
                      border: "1px solid rgba(16,185,129,0.4)",
                      borderRadius: "0.75rem",
                      fontSize: "11px",
                      color: "#ECFDF5",
                    }}
                    formatter={(value, name) => {
                      if (value === null || value === undefined || Number.isNaN(value)) return "—";
                      if (name === "oee_pct") return [`${Number(value).toFixed(1)}%`, "OEE %"];
                      return [Number(value).toFixed(1), name];
                    }}
                    labelFormatter={(label, payload) => {
                      const po = payload && payload.length ? payload[0].payload.po_number : "";
                      return `${label || "Unknown"} • PO ${po}`;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#ECFDF5" }} />
                  <Line type="monotone" dataKey="total_cost" name="Total Cost" stroke="#22d3ee" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="lead_time_days" name="Lead Time (days)" stroke="#a855f7" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="defect_quantity" name="Defect Qty" stroke="#f97316" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="oee_pct" name="OEE %" stroke="#4ade80" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

      </div>
    </section>
  );
}

export default IntegratedDashboard;
