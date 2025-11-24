import React, { useEffect, useMemo, useState } from "react";
import supabase from "../lib/supabaseClient";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  LineChart,
  Line,
  BarChart,
  Bar,
  Legend,
} from "recharts";

// ERP dashboard mirrors the CRM pattern:
// - Apply filters server-side (year/region/location)
// - Fetch only needed columns
// - Compute KPIs client-side (cost per good unit, avg cycle time, utilization)
function ERPDashboard({ onBack }) {
  // Compact currency formatter for axis/tooltip (auto scales to K / M / B)
  const formatCurrencyShort = (value, digits = 1) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return "$0";
    const abs = Math.abs(num);
    if (abs >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(digits)}B`;
    if (abs >= 1_000_000) return `$${(num / 1_000_000).toFixed(digits)}M`;
    if (abs >= 1_000) return `$${(num / 1_000).toFixed(digits)}K`;
    return `$${num.toFixed(0)}`;
  };

  const [rows, setRows] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);

  const [selectedYear, setSelectedYear] = useState("All");
  const [selectedRegion, setSelectedRegion] = useState("All");
  const [selectedLocation, setSelectedLocation] = useState("All");

  // Fetch ERP rows once (chunked) and apply filters client-side (matches CRM pattern)
  useEffect(() => {
    const loadData = async () => {
      setDataLoading(true);
      setDataError(null);
      try {
        // Chunked pull; client-side filtering thereafter
        const chunkSize = 20000;
        const maxRows = 140000;
        let offset = 0;
        let aggregated = [];
        while (true) {
          const { data, error } = await supabase
            .schema("erp")
            .from("erp_funnel_view")
            .select(
              [
                "funnel_year",
                "region",
                "location",
                "supplier_id",
                "supplier_name",
                "total_cost",
                "scrap_value",
                "good_pieces",
                "end_to_end_cycle_days",
                "supplier_rating",
                "yield_rate_pct",
                "po_number",
                "on_time_fulfillment_flag",
                "produced_quantity",
                "received_quantity",
                "inventory_value",
                "obsolete_flag",
              ].join(", ")
            )
            .range(offset, offset + chunkSize - 1);
          if (error) throw error;

          const batch = data || [];
          aggregated = aggregated.concat(batch);
          if (batch.length < chunkSize || aggregated.length >= maxRows) break;
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
  }, []); // load once; filters applied client-side

  const {
    yearOptions,
    regionOptions,
    locationOptions,
    kpiCards,
    supplierScatter,
    onTimeHeatmap,
    heatmapYears,
    heatmapRegions,
    cycleTrend,
    costBreakdown,
  } = useMemo(() => {
    // Build filter options from fetched rows
    const yearList = Array.from(
      new Set(
        rows
          .map((r) => r.funnel_year)
          .filter((v) => v !== null && v !== undefined && v !== "")
          .map((v) => String(v))
      )
    )
      .map((v) => (Number.isNaN(Number(v)) ? v : Number(v)))
      .sort((a, b) => (a > b ? 1 : -1))
      .map((v) => String(v));

    let filteredForRegions = rows;
    if (selectedYear !== "All") {
      filteredForRegions = filteredForRegions.filter(
        (r) => String(r.funnel_year) === selectedYear
      );
    }

    const regionList = Array.from(
      new Set(
        filteredForRegions
          .map((r) => r.region)
          .filter((v) => v !== null && v !== undefined && v !== "")
      )
    ).sort();

    let filteredForLocations = filteredForRegions;
    if (selectedRegion !== "All") {
      filteredForLocations = filteredForLocations.filter(
        (r) => r.region === selectedRegion
      );
    }

    const locationList = Array.from(
      new Set(
        filteredForLocations
          .map((r) => r.location)
          .filter((v) => v !== null && v !== undefined && v !== "")
      )
    ).sort();

    // KPIs (client-side): apply all filters
    let filtered = filteredForLocations;
    if (selectedLocation !== "All") {
      filtered = filtered.filter((r) => r.location === selectedLocation);
    }
    let costNumerator = 0; // total_cost + scrap_value
    let goodPieces = 0;
    let cycleSum = 0;
    let cycleCount = 0;
    let producedSum = 0;
    let receivedSum = 0;
    const supplierMap = new Map();
    const costByYear = new Map();
    const cycleByYear = new Map();
    const heatmapMap = new Map(); // region|year -> sets of POs and on-time
    const locMap = new Map(); // location|year -> {pos:Set,on:Set,region} (kept for future map use, not returned)
    const costBreakdownMap = new Map(); // year -> {procurement, scrap, obsolete}

    filtered.forEach((r) => {
      const cost = Number(r.total_cost) || 0;
      const scrap = Number(r.scrap_value) || 0;
      costNumerator += cost + scrap;
      goodPieces += Number(r.good_pieces) || 0;
      const yr = r.funnel_year ?? "Unknown";
      if (!costByYear.has(yr)) {
        costByYear.set(yr, { num: 0, den: 0 });
      }
      const cy = costByYear.get(yr);
      cy.num += cost + scrap;
      cy.den += Number(r.good_pieces) || 0;

      if (r.end_to_end_cycle_days !== null && r.end_to_end_cycle_days !== undefined) {
        const days = Number(r.end_to_end_cycle_days);
        if (!Number.isNaN(days)) {
          cycleSum += days;
          cycleCount += 1;
          if (!cycleByYear.has(yr)) {
            cycleByYear.set(yr, { sum: 0, count: 0 });
          }
          const cyb = cycleByYear.get(yr);
          cyb.sum += days;
          cyb.count += 1;
        }
      }

      producedSum += Number(r.produced_quantity) || 0;
      receivedSum += Number(r.received_quantity) || 0;

      // Supplier scatter aggregation
      const sid =
        r.supplier_id !== null && r.supplier_id !== undefined
          ? r.supplier_id
          : "Unknown";
      const name = r.supplier_name || "Unknown";
      if (!supplierMap.has(sid)) {
        supplierMap.set(sid, {
          supplier_id: sid,
          supplier_name: name,
          ratingSum: 0,
          ratingCount: 0,
          yieldSum: 0,
          yieldCount: 0,
          spend: 0,
        });
      }
      const entry = supplierMap.get(sid);
      entry.supplier_name = name;
      if (r.supplier_rating !== null && r.supplier_rating !== undefined) {
        const val = Number(r.supplier_rating);
        if (!Number.isNaN(val)) {
          entry.ratingSum += val;
          entry.ratingCount += 1;
        }
      }
      if (r.yield_rate_pct !== null && r.yield_rate_pct !== undefined) {
        const val = Number(r.yield_rate_pct);
        if (!Number.isNaN(val)) {
          entry.yieldSum += val;
          entry.yieldCount += 1;
        }
      }
      entry.spend += Number(r.total_cost) || 0;

      // Heatmap aggregation by region + year (distinct POs)
      const regionKey = r.region || "Unknown";
      const yearKey = String(r.funnel_year ?? "Unknown");
      const hmKey = `${regionKey}||${yearKey}`;
      if (!heatmapMap.has(hmKey)) {
        heatmapMap.set(hmKey, {
          region: regionKey,
          year: yearKey,
          pos: new Set(),
          ontime: new Set(),
        });
      }
      const hm = heatmapMap.get(hmKey);
      const poKey =
        r.po_number !== null && r.po_number !== undefined
          ? r.po_number
          : `po-${hm.pos.size}`;
      hm.pos.add(poKey);
      if (r.on_time_fulfillment_flag === true) {
        hm.ontime.add(poKey);
      }

      const locKey = r.location || "Unknown";
      const locYearKey = `${locKey}||${yearKey}`;
      if (!locMap.has(locYearKey)) {
        locMap.set(locYearKey, {
          location: locKey,
          region: regionKey,
          year: yearKey,
          pos: new Set(),
          ontime: new Set(),
        });
      }
      const lm = locMap.get(locYearKey);
      lm.pos.add(poKey);
      if (r.on_time_fulfillment_flag === true) {
        lm.ontime.add(poKey);
      }

      // Cost breakdown per year
      const breakdownYear = String(r.funnel_year ?? "Unknown");
      if (!costBreakdownMap.has(breakdownYear)) {
        costBreakdownMap.set(breakdownYear, {
          year: breakdownYear,
          procurement_cost: 0,
          scrap_cost: 0,
          obsolete_cost: 0,
        });
      }
      const cb = costBreakdownMap.get(breakdownYear);
      cb.procurement_cost += cost;
      cb.scrap_cost += scrap;
      if (r.obsolete_flag === true) {
        const invVal = Number(r.inventory_value);
        if (!Number.isNaN(invVal)) {
          cb.obsolete_cost += invVal;
        }
      }
    });

    const costPerGood =
      goodPieces > 0 ? (costNumerator / goodPieces).toFixed(2) : null;
    const avgCycle =
      cycleCount > 0 ? (cycleSum / cycleCount).toFixed(1) : null;
    const utilization =
      receivedSum > 0 ? ((producedSum / receivedSum) * 100).toFixed(1) : null;

    const supplierScatter = Array.from(supplierMap.values())
      .map((e) => {
        const avgRating =
          e.ratingCount > 0 ? e.ratingSum / e.ratingCount : null;
        const avgYield = e.yieldCount > 0 ? e.yieldSum / e.yieldCount : null;
        if (avgRating === null || avgYield === null) return null;
        return {
          supplier_id: e.supplier_id,
          supplier_name: e.supplier_name,
          avgRating,
          avgYield,
          totalSpend: e.spend,
        };
      })
      .filter(Boolean);

    const onTimeHeatmap = Array.from(heatmapMap.values())
      .map((v) => {
        const total = v.pos.size;
        const ontime = v.ontime.size;
        const rate = total > 0 ? (ontime / total) * 100 : null;
        return {
          region: v.region,
          year: v.year,
          rate,
        };
      })
      .filter((v) => v.rate !== null);

    const heatmapYears = Array.from(new Set(onTimeHeatmap.map((h) => h.year))).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    const heatmapRegions = Array.from(new Set(onTimeHeatmap.map((h) => h.region))).sort();

    const cycleTrend = Array.from(cycleByYear.entries())
      .map(([yr, v]) => ({
        year: String(yr),
        avg: v.count > 0 ? v.sum / v.count : 0,
      }))
      .filter((row) => {
        const n = Number(row.year);
        return !Number.isNaN(n) && n <= 2025;
      })
      .sort((a, b) => Number(a.year) - Number(b.year));

    const costBreakdown = Array.from(costBreakdownMap.values())
      .filter((row) => {
        const n = Number(row.year);
        return !Number.isNaN(n) && n <= 2025;
      })
      .sort((a, b) => Number(a.year) - Number(b.year));


    const cards = [
      {
        id: "cost-good",
        label: "Cost per Good Unit",
        value:
          dataLoading || dataError
            ? "—"
            : costPerGood === null
            ? "—"
            : `$ ${Number(costPerGood).toLocaleString()}`,
        helper: "Total cost incl. scrap divided by good pieces.",
      },
      {
        id: "cycle",
        label: "Avg End-to-End Cycle",
        value:
          dataLoading || dataError
            ? "—"
            : avgCycle === null
            ? "—"
            : `${avgCycle} days`,
        helper: "Purchase order to last movement.",
      },
      {
        id: "util",
        label: "Material to Production Utilization",
        value:
          dataLoading || dataError
            ? "—"
            : utilization === null
            ? "—"
            : `${utilization}%`,
        helper: "Produced vs received quantity.",
      },
    ];

    return {
      yearOptions: ["All", ...yearList],
      regionOptions: ["All", ...regionList],
      locationOptions: ["All", ...locationList],
      kpiCards: cards,
      supplierScatter,
      onTimeHeatmap,
      heatmapYears,
      heatmapRegions,
      cycleTrend,
      costBreakdown,
    };
  }, [rows, selectedRegion, selectedLocation, selectedYear, dataLoading, dataError]);

  return (
    <section className="max-w-7xl mx-auto mt-10">
      <div className="rounded-3xl border border-emerald-500/30 bg-black/20 px-5 py-6 shadow-emerald-900/40 shadow-2xl backdrop-blur-md md:px-8 md:py-8">
        {/* Top bar with back button + breadcrumb */}
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
            Home / ERP Analytics /{" "}
            <span className="text-emerald-50">Procurement &amp; Production</span>
          </div>
        </div>

        {/* Module header */}
        <div className="mt-6">
          <p className="inline-flex items-center gap-2 rounded-full bg-emerald-900/60 border border-emerald-400/40 px-4 py-1 text-xs text-emerald-100">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            ERP Module
          </p>
          <h2 className="mt-3 text-2xl md:text-3xl font-bold text-white tracking-tight">
            Supply-to-Stock KPIs: Cost, Cycle Time, Utilization
          </h2>
          <p className="mt-2 text-sm text-emerald-100/80 max-w-2xl">
            Track procurement spend to good units, end-to-end cycle speed, and material utilization across regions and locations.
          </p>
        </div>

        {/* Error message */}
        {dataError && (
          <p className="mt-4 text-xs text-red-200">
            Failed to load data: {dataError}
          </p>
        )}

        {/* FILTER BAR */}
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Year</label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="bg-[#050908]/70 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm text-emerald-50
                         focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            >
              {yearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Region</label>
            <select
              value={selectedRegion}
              onChange={(e) => {
                setSelectedRegion(e.target.value);
                setSelectedLocation("All");
              }}
              className="bg-[#050908]/70 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm text-emerald-50
                         focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            >
              {regionOptions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Location</label>
            <select
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
              className="bg-[#050908]/70 border border-emerald-500/40 rounded-xl px-3 py-2 text-sm text-emerald-50
                         focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            >
              {locationOptions.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* KPI CARDS */}
        <div className="mt-8 grid gap-6 grid-cols-1 md:grid-cols-3">
          {kpiCards.map((kpi, index) => (
            <div
              key={kpi.id}
              className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-5 shadow-lg backdrop-blur-sm
                         flex flex-col justify-between
                         hover:border-emerald-300 hover:shadow-emerald-400/30 transition-all duration-300
                         hover:-translate-y-1"
              style={{
                animation: "fadeInUp 0.9s ease-out forwards",
                animationDelay: `${0.15 * (index + 1)}s`,
              }}
            >
              <p className="text-xs uppercase tracking-wide text-emerald-200/80">
                {kpi.label}
              </p>
              <p className="mt-3 text-xl md:text-2xl font-semibold text-white leading-tight break-words">
                {kpi.value}
              </p>
              <p className="mt-3 text-xs text-emerald-100/70">{kpi.helper}</p>
            </div>
          ))}
        </div>

        {/* Supplier Quality vs Production Yield (Scatter) */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Supplier Quality vs Production Yield
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                Each bubble is a supplier (avg rating vs avg yield); bubble size shows total spend.
              </p>
            </div>
          </div>

          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">Unable to load supplier scatter.</div>
          ) : !supplierScatter.length ? (
            <div className="text-xs text-emerald-100/70">
              No supplier data for this filter selection.
            </div>
          ) : (
            <div className="w-full" style={{ height: 360 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart
                  data={supplierScatter}
                  margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(16, 185, 129, 0.18)" />
                  <XAxis
                    type="number"
                    dataKey="avgRating"
                    name="Avg Supplier Rating"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    domain={["auto", "auto"]}
                    label={{
                      value: "Avg Supplier Rating",
                      position: "insideBottom",
                      offset: -25,
                      fill: "#A7F3D0",
                      fontSize: 11,
                    }}
                  />
                  <YAxis
                    type="number"
                    dataKey="avgYield"
                    name="Avg Yield Rate (%)"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    domain={["auto", "auto"]}
                    label={{
                      value: "Avg Yield Rate (%)",
                      angle: -90,
                      position: "insideLeft",
                      offset: 0,
                      fill: "#A7F3D0",
                      fontSize: 11,
                    }}
                  />
                  <ZAxis
                    type="number"
                    dataKey="totalSpend"
                    range={[60, 260]}
                    name="Total Spend"
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(16,185,129,0.4)", strokeWidth: 1 }}
                    contentStyle={{
                      backgroundColor: "#022c22",
                      border: "1px solid rgba(16,185,129,0.4)",
                      borderRadius: "0.75rem",
                      fontSize: "11px",
                      color: "#ECFDF5",
                    }}
                    formatter={(value, name, props) => {
                      if (name === "avgRating") return [value.toFixed(2), "Avg Rating"];
                      if (name === "avgYield") return [`${value.toFixed(1)}%`, "Avg Yield"];
                      if (name === "totalSpend")
                        return [`$${Math.round(value).toLocaleString()}`, "Total Spend"];
                      return [value, name];
                    }}
                    labelFormatter={() => ""}
                    itemSorter={(item) => item.name}
                  />
                  <Scatter
                    name="Suppliers"
                    data={supplierScatter}
                    fill="#2dd4bf"
                    fillOpacity={0.7}
                    stroke="#0ea5e9"
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Supplier Region vs On-Time Fulfillment Heatmap */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                On-Time Fulfillment by Region & Year
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                Distinct POs delivered on time, grouped by region and year.
              </p>
            </div>
          </div>

          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">
              Unable to load on-time fulfillment data.
            </div>
          ) : !onTimeHeatmap.length ? (
            <div className="text-xs text-emerald-100/70">
              No on-time data for this filter selection.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[520px] text-sm text-emerald-50/90">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left text-emerald-100/80">Region \ Year</th>
                    {heatmapYears.map((yr) => (
                      <th key={yr} className="px-3 py-2 text-center text-emerald-100/80">
                        {yr}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmapRegions.map((reg) => (
                    <tr key={reg}>
                      <td className="px-3 py-2 font-semibold text-emerald-100">{reg}</td>
                      {heatmapYears.map((yr) => {
                        const found = onTimeHeatmap.find(
                          (h) => h.region === reg && h.year === yr
                        );
                        const pct = found ? found.rate : null;
                        const clamped = pct !== null ? Math.max(0, Math.min(100, pct)) : 0;
                        const g = Math.round(40 + (clamped / 100) * 170); // darker to lighter green
                        const bg = pct !== null ? `rgba(16, ${g}, 96, 0.25)` : "transparent";
                        return (
                          <td
                            key={`${reg}-${yr}`}
                            className="px-3 py-2 text-center border border-emerald-500/20"
                            style={{ backgroundColor: bg }}
                          >
                            {pct === null ? "—" : `${pct.toFixed(1)}%`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Supply Chain Cost Breakdown (Stacked Bar) */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Supply Chain Cost Breakdown
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                Procurement, scrap, and obsolete stock costs by year with current filters.
              </p>
            </div>
          </div>

          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">
              Unable to load cost breakdown.
            </div>
          ) : !costBreakdown.length ? (
            <div className="text-xs text-emerald-100/70">
              No cost data for this filter selection.
            </div>
          ) : (
            <div className="w-full" style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={costBreakdown}
                  margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(16, 185, 129, 0.18)" />
                  <XAxis
                    dataKey="year"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    height={35}
                  />
                  <YAxis
                    tickFormatter={(v) => formatCurrencyShort(v, 1)}
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(16,185,129,0.08)" }}
                    contentStyle={{
                      backgroundColor: "#022c22",
                      border: "1px solid rgba(16,185,129,0.4)",
                      borderRadius: "0.75rem",
                      fontSize: "11px",
                      color: "#ECFDF5",
                    }}
                    formatter={(value, name) => [
                      formatCurrencyShort(value, 2),
                      name === "procurement_cost"
                        ? "Procurement"
                        : name === "scrap_cost"
                        ? "Scrap"
                        : "Obsolete",
                    ]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: "#A7F3D0" }}
                    formatter={(value) => {
                      if (value === "procurement_cost") return "Procurement";
                      if (value === "scrap_cost") return "Scrap";
                      return "Obsolete";
                    }}
                  />
                  <Bar dataKey="procurement_cost" stackId="cost" fill="#34d399" />
                  <Bar dataKey="scrap_cost" stackId="cost" fill="#f59e0b" />
                  <Bar dataKey="obsolete_cost" stackId="cost" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* End-to-End Cycle Time Trend (Yearly) */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                End-to-End Cycle Time Trend
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                Average PO creation to last movement, by year, with current filters.
              </p>
            </div>
          </div>

          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">Unable to load cycle trend.</div>
          ) : !cycleTrend.length ? (
            <div className="text-xs text-emerald-100/70">
              No cycle time data for this filter selection.
            </div>
          ) : (
            <div className="w-full" style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={cycleTrend}
                  margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(16, 185, 129, 0.18)" />
                  <XAxis
                    dataKey="year"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    height={35}
                  />
                  <YAxis
                    tickFormatter={(v) => `${v.toFixed(1)}d`}
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(16,185,129,0.4)", strokeWidth: 1 }}
                    contentStyle={{
                      backgroundColor: "#022c22",
                      border: "1px solid rgba(16,185,129,0.4)",
                      borderRadius: "0.75rem",
                      fontSize: "11px",
                      color: "#ECFDF5",
                    }}
                    formatter={(value) => [`${Number(value).toFixed(1)} days`, "Avg cycle time"]}
                    labelFormatter={(label) => `Year: ${label}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="avg"
                    stroke="#34D399"
                    strokeWidth={2}
                    dot={{ r: 3, strokeWidth: 1 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

      </div>
    </section>
  );
}

export default ERPDashboard;
