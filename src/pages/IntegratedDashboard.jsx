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

import {
  ComposableMap,
  Geographies,
  Geography,
   Marker,
  ZoomableGroup,
} from "react-simple-maps";

/* ===========================
   Helpers
   =========================== */

// Robust year extractor for date strings; falls back to regex if Date parsing fails
const extractYear = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.getFullYear();
  const match = String(value).match(/(\d{4})/);
  return match ? Number(match[1]) : null;
};

const norm = (v) => (v === null || v === undefined ? null : String(v).trim());

const eqi = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};

/* ===========================
   PO-level transformer
   =========================== */

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
        risk_score:
          r.risk_score !== null && r.risk_score !== undefined
            ? Number(r.risk_score)
            : null,
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
    const rowRisk =
      r.risk_score !== null && r.risk_score !== undefined
        ? Number(r.risk_score)
        : null;
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
        g.lead_time_days_count > 0
          ? g.lead_time_days_sum / g.lead_time_days_count
          : null,
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
      const da = a.po_creation_date
        ? new Date(a.po_creation_date).getTime()
        : Infinity;
      const db = b.po_creation_date
        ? new Date(b.po_creation_date).getTime()
        : Infinity;
      return da - db;
    });

  // max risk (used only for color)
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

/* ===========================
   Risk summarizer
   =========================== */

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

    if (
      p.risk_score !== null &&
      p.risk_score !== undefined &&
      !Number.isNaN(p.risk_score)
    ) {
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

/* ===========================
   Bubble map helpers
   =========================== */

// Simple city-level overrides (optional refinement)
const CITY_COORDS = {
  "dallas, tx": [-96.797, 32.7767],
  "tokyo, jp": [139.6917, 35.6895],
  "singapore": [103.8198, 1.3521],
  "mumbai, in": [72.8777, 19.076],
  "shanghai, cn": [121.4737, 31.2304],
  "berlin, de": [13.405, 52.52],
  "paris, fr": [2.3522, 48.8566],
  "london, uk": [-0.1276, 51.5074],
  "chicago, il": [-87.6298, 41.8781],
  "los angeles, ca": [-118.2437, 34.0522],
};

// Heuristic mapping from region/location → [lon, lat]
function getCoords(region, location) {
  const loc = location ? String(location).trim().toLowerCase() : "";
  if (loc && CITY_COORDS[loc]) {
    return CITY_COORDS[loc];
  }

  const regionStr = region ? String(region).trim().toLowerCase() : "";

  // Region-based fallbacks
  if (
    regionStr.includes("north america") ||
    regionStr === "na" ||
    regionStr.includes("united states") ||
    regionStr.includes("usa")
  ) {
    return [-98, 39]; // US centroid-ish
  }
  if (
    regionStr.includes("emea") ||
    regionStr.includes("europe") ||
    regionStr.includes("middle east") ||
    regionStr.includes("africa")
  ) {
    return [10, 50];
  }
  if (
    regionStr.includes("apac") ||
    regionStr.includes("asia") ||
    regionStr.includes("pacific")
  ) {
    return [105, 15];
  }

  // Location-only fallbacks if region is missing/unclear
  if (loc.includes("usa") || loc.includes("united states") || loc.includes("tx")) {
    return [-98, 39];
  }
  if (loc.includes("germany") || loc.includes("france") || loc.includes("uk")) {
    return [10, 50];
  }
  if (
    loc.includes("india") ||
    loc.includes("china") ||
    loc.includes("japan") ||
    loc.includes("singapore")
  ) {
    return [105, 15];
  }

  return null;
}

// Build bubble nodes aggregated by physical location & role
function buildBubbleMapData(filteredRows) {
  if (!filteredRows || !filteredRows.length) return [];

  const nodeMap = new Map();

  const ensureNode = (role, id, name, region, location, row) => {
    if (!id || !location) return;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        role, // "customer" | "supplier" | "plant"
        name: name || location || region || id,
        region: region || null,
        location: location || null,
        poSet: new Set(),
        total_cost_sum: 0,
        lead_time_sum: 0,
        lead_time_count: 0,
        defect_qty_sum: 0,
        oee_sum: 0,
        oee_count: 0,
        risk_sum: 0,
        risk_count: 0,
      });
    }
    const n = nodeMap.get(id);

    if (row.po_number) n.poSet.add(row.po_number);

    const cost = Number(row.total_cost);
    if (!Number.isNaN(cost)) n.total_cost_sum += cost;

    const ltd = Number(row.lead_time_days);
    if (!Number.isNaN(ltd)) {
      n.lead_time_sum += ltd;
      n.lead_time_count += 1;
    }

    const defect = Number(row.defect_quantity);
    if (!Number.isNaN(defect)) n.defect_qty_sum += defect;

    const oee = Number(row.oee_pct);
    if (!Number.isNaN(oee)) {
      n.oee_sum += oee;
      n.oee_count += 1;
    }

    const rs =
      row.risk_score !== null && row.risk_score !== undefined
        ? Number(row.risk_score)
        : NaN;
    if (!Number.isNaN(rs)) {
      n.risk_sum += rs;
      n.risk_count += 1;
    }
  };

  filteredRows.forEach((r) => {
    // Customer node
    const custLoc = r.customer_location || null;
    const custRegion = r.customer_region || null;
    const custName = r.customer_name || custLoc;
    if (custLoc) {
      const id = `customer:${custLoc}`;
      ensureNode("customer", id, custName, custRegion, custLoc, r);
    }

    // Supplier node
    const suppLoc = r.supplier_location || null;
    const suppRegion = r.supplier_region || null;
    const suppName = r.supplier_name || suppLoc;
    if (suppLoc) {
      const id = `supplier:${suppLoc}`;
      ensureNode("supplier", id, suppName, suppRegion, suppLoc, r);
    }

    // Plant node
    const plantLoc = r.plant_location || r.plant_id || null;
    const plantRegion = r.plant_region || null;
    const plantName = r.plant_id || plantLoc;
    if (plantLoc) {
      const id = `plant:${plantLoc}`;
      ensureNode("plant", id, plantName, plantRegion, plantLoc, r);
    }
  });

  const nodes = [];

  nodeMap.forEach((n) => {
    const coords = getCoords(n.region, n.location);
    if (!coords) return; // skip nodes without usable coordinates

    const po_count = n.poSet.size;
    const avg_lead_time_days =
      n.lead_time_count > 0 ? n.lead_time_sum / n.lead_time_count : null;
    const avg_oee_pct = n.oee_count > 0 ? n.oee_sum / n.oee_count : null;
    const avg_risk_score =
      n.risk_count > 0 ? n.risk_sum / n.risk_count : null;

    let risk_bucket = "No Data";
    if (avg_risk_score !== null && !Number.isNaN(avg_risk_score)) {
      if (avg_risk_score >= 11) risk_bucket = "High";
      else if (avg_risk_score >= 5) risk_bucket = "Medium";
      else if (avg_risk_score < 5) risk_bucket = "Safe";
    }

    nodes.push({
      id: n.id,
      role: n.role,
      name: n.name,
      region: n.region,
      location: n.location,
      coords,
      po_count,
      total_cost_sum: n.total_cost_sum,
      avg_lead_time_days,
      defect_qty_sum: n.defect_qty_sum,
      avg_oee_pct,
      avg_risk_score,
      risk_bucket,
    });
  });

  return nodes;
}

/* ===========================
   Geo bubble map component
   =========================== */

const WORLD_GEO_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

function BubbleSupplyMap({ nodes, filters }) {
  const plottedNodes = Array.isArray(nodes) ? nodes.filter((n) => n.coords) : [];

  const hasData = plottedNodes.length > 0 && filters.customer;
  if (!hasData) {
    return (
      <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
        <h3 className="text-sm font-semibold text-white">Location Footprint</h3>
        <p className="mt-1 text-xs text-emerald-100/70">
          Select a customer (and optionally part / vendor) to see the location
          footprint.
        </p>
        <div className="mt-3 text-xs text-emerald-100/70">
          No locations for this selection.
        </div>
      </div>
    );
  }

  // Auto-center & zoom based on node coordinates
  let center = [20, 20];
  let zoom = 1.3;
  if (plottedNodes.length > 0) {
    const lons = plottedNodes.map((n) => n.coords[0]);
    const lats = plottedNodes.map((n) => n.coords[1]);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const spanLon = Math.abs(maxLon - minLon);
    const spanLat = Math.abs(maxLat - minLat);
    const span = Math.max(spanLon, spanLat);

    center = [(minLon + maxLon) / 2 || 20, (minLat + maxLat) / 2 || 20];

    if (span > 120) zoom = 0.9;
    else if (span > 60) zoom = 1.2;
    else if (span > 30) zoom = 1.6;
    else zoom = 2.0;
  }

  const bubbleRadius = (node) => {
    const base = Math.log10((node.total_cost_sum || 0) + 10);
    const scaled = base * 4;
    return Math.min(20, Math.max(6, scaled));
  };

  const roleFill = (role) => {
    if (role === "customer") return "#22c55e"; // emerald
    if (role === "supplier") return "#f97316"; // orange
    if (role === "plant") return "#38bdf8"; // blue
    return "#6b7280";
  };

  const riskStroke = (bucket) => {
    if (bucket === "High") return "#ef4444"; // red
    if (bucket === "Medium") return "#facc15"; // yellow
    if (bucket === "Safe") return "#22c55e"; // green
    return "#0d9488"; // teal-ish for "No Data"
  };

  // Small role-based offsets so bubbles at the same location don't fully overlap
  const offsetCoordsForRole = (node) => {
    const [lon, lat] = node.coords;
    const delta = 1; // ~1 degree separation – enough to see distinct bubbles

    if (node.role === "customer") {
      // Keep customer near the original point
      return [lon, lat];
    }
    if (node.role === "supplier") {
      // Shift slightly west/south
      return [lon - delta, lat - delta * 0.4];
    }
    if (node.role === "plant") {
      // Shift slightly east/south
      return [lon + delta, lat - delta * 0.4];
    }
    return [lon, lat];
  };

  const tooltipTitle = (node) => {
    const headerPrefix =
      node.role === "customer"
        ? "Customer"
        : node.role === "supplier"
        ? "Supplier"
        : "Plant";

    const header = `${headerPrefix}: ${node.name} (${node.region ?? "—"} — ${
      node.location ?? "—"
    })`;

    const poLine = `POs: ${node.po_count ?? 0}`;
    const costLine = `Total Cost: $${Number(
      node.total_cost_sum || 0
    ).toLocaleString()}`;
    const leadLine = `Avg Lead Time: ${
      node.avg_lead_time_days != null && !Number.isNaN(node.avg_lead_time_days)
        ? node.avg_lead_time_days.toFixed(1)
        : "—"
    } days`;
    const defectLine = `Defect Qty: ${node.defect_qty_sum ?? 0}`;
    const oeeLine = `Avg OEE: ${
      node.avg_oee_pct != null && !Number.isNaN(node.avg_oee_pct)
        ? `${node.avg_oee_pct.toFixed(1)}%`
        : "—"
    }`;
    const riskScoreLine = `Avg Risk Score: ${
      node.avg_risk_score != null && !Number.isNaN(node.avg_risk_score)
        ? node.avg_risk_score.toFixed(1)
        : "—"
    } (${node.risk_bucket})`;

    return [
      header,
      poLine,
      costLine,
      leadLine,
      defectLine,
      oeeLine,
      riskScoreLine,
    ].join("\n");
  };

  return (
    <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Location Footprint</h3>
          <p className="mt-1 text-xs text-emerald-100/70">
            Bubble size = PO cost, fill color = role, border color = risk.
          </p>
        </div>
      </div>

      {/* Zoomable bubble map */}
      <div className="w-full" style={{ height: 420 }}>
        <ComposableMap
          projection="geoMercator"
          projectionConfig={{ scale: 150 }}
          style={{ width: "100%", height: "100%" }}
        >
          <ZoomableGroup center={center} zoom={zoom} minZoom={0.7} maxZoom={4}>
            <Geographies geography={WORLD_GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    fill="#022c22"
                    stroke="#064e3b"
                    strokeWidth={0.4}
                  />
                ))
              }
            </Geographies>

            {/* Bubbles per physical location (role-offset to avoid perfect overlap) */}
            {plottedNodes.map((node) => (
              <Marker key={node.id} coordinates={offsetCoordsForRole(node)}>
                <title>{tooltipTitle(node)}</title>
                <circle
                  r={bubbleRadius(node)}
                  fill={roleFill(node.role)}
                  stroke={riskStroke(node.risk_bucket)}
                  strokeWidth={1.4}
                  opacity={0.9}
                />
              </Marker>
            ))}
          </ZoomableGroup>
        </ComposableMap>
      </div>

      {/* Legend below map */}
      <div className="mt-4 grid gap-3 md:grid-cols-3 text-xs text-emerald-100/80">
        <div>
          <div className="font-semibold text-emerald-200 mb-1">Legend</div>
          <p className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            <span>Green circle = Customer location</span>
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
            <span>Orange circle = Supplier location</span>
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-sky-400" />
            <span>Blue circle = Plant location</span>
          </p>
          <p className="mt-1">Bubble size scales with total PO cost.</p>
        </div>
        <div>
          <div className="font-semibold text-emerald-200 mb-1">
            Risk (border color)
          </div>
          <p>Green = Safe</p>
          <p>Yellow = Medium</p>
          <p>Red = High</p>
          <p>Teal = No Data</p>
        </div>
        <div>
          <div className="font-semibold text-emerald-200 mb-1">
            How to read
          </div>
          <p>Each bubble represents a customer, supplier, or plant location.</p>
          <p>Hover a bubble to see PO count, cost, lead time, quality, and risk.</p>
        </div>
      </div>
    </div>
  );
}

/* ===========================
   Main dashboard
   =========================== */

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
                "customer_region",
                "customer_location",
                "part_name",
                "supplier_name",
                "supplier_region",
                "supplier_location",
                "plant_id",
                "plant_region",
                "plant_location",
                "po_number",
                "po_creation_date",
                "total_cost",
                "lead_time_days",
                "defect_quantity",
                "produced_quantity",
                "good_pieces",
                "oee_pct",
                "on_time_fulfillment_flag",
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
  const {
    customerOptions,
    partOptions,
    supplierOptions,
    poLevelData,
    riskSummary,
    bubbleNodes,
  } = useMemo(() => {
    const customerOptions = Array.from(
      new Set(rows.map((r) => norm(r.customer_name)).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    const customerFiltered = !filters.customer
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
      new Set(
        supplierSource.map((r) => norm(r.supplier_name)).filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    // Apply filters: customer required, part/supplier optional ("All")
    const filteredRows = rows.filter((r) => {
      if (!filters.customer) return false;
      if (!eqi(r.customer_name, filters.customer)) return false;
      if (filters.part !== "All" && !eqi(r.part_name, filters.part)) return false;
      if (filters.supplier !== "All" && !eqi(r.supplier_name, filters.supplier))
        return false;
      return true;
    });

    const { poLevelData, riskSummary } = transformRowsToPOLevel(filteredRows);
    const bubbleNodes = buildBubbleMapData(filteredRows);

    return {
      customerOptions,
      partOptions,
      supplierOptions,
      poLevelData,
      riskSummary,
      bubbleNodes,
    };
  }, [rows, filters]);

  // Final chart dataset: keep only rows with a valid year <= 2025
  const chartData = useMemo(() => {
    // base: PO-level, capped at 2025
    const base = poLevelData.filter((p) => {
      const yr = extractYear(p.po_creation_date);
      return yr !== null && yr <= 2025;
    });

    const aggregateByMonth =
      filters.part === "All" && filters.supplier === "All";
    if (!aggregateByMonth) return base;

    // bucket by month when part/vendor is "All"
    const buckets = new Map();
    base.forEach((p) => {
      if (!p.po_creation_date) return;
      const d = new Date(p.po_creation_date);
      if (Number.isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          po_creation_date: `${key}-01`,
          total_cost: 0,
          lead_time_days_sum: 0,
          lead_time_days_count: 0,
          defect_quantity: 0,
          oee_sum: 0,
          oee_count: 0,
        });
      }
      const b = buckets.get(key);
      b.total_cost += Number(p.total_cost) || 0;
      if (
        p.lead_time_days !== null &&
        p.lead_time_days !== undefined &&
        !Number.isNaN(p.lead_time_days)
      ) {
        b.lead_time_days_sum += Number(p.lead_time_days);
        b.lead_time_days_count += 1;
      }
      b.defect_quantity += Number(p.defect_quantity) || 0;
      if (
        p.oee_pct !== null &&
        p.oee_pct !== undefined &&
        !Number.isNaN(p.oee_pct)
      ) {
        b.oee_sum += Number(p.oee_pct);
        b.oee_count += 1;
      }
    });

    return Array.from(buckets.values())
      .map((b) => ({
        po_creation_date: b.po_creation_date,
        total_cost: b.total_cost,
        lead_time_days:
          b.lead_time_days_count > 0
            ? b.lead_time_days_sum / b.lead_time_days_count
            : null,
        defect_quantity: b.defect_quantity,
        oee_pct: b.oee_count > 0 ? b.oee_sum / b.oee_count : null,
      }))
      .sort(
        (a, b) => new Date(a.po_creation_date) - new Date(b.po_creation_date)
      );
  }, [poLevelData, filters.part, filters.supplier]);

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
    if (
      filters.customer &&
      customerOptions.length > 0 &&
      !customerOptions.includes(filters.customer)
    ) {
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

  const canShowRisk =
    Boolean(filters.customer) &&
    filters.part !== "All" &&
    filters.supplier !== "All";

  const distribution = useMemo(
    () => (canShowRisk ? summarizeRisk(poLevelData) : null),
    [canShowRisk, poLevelData]
  );

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
            Track PO-level cost, lead time, defects, OEE, risk, and geo flow with
            synchronized customer, part, and supplier filters.
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
            <div className="text-xs text-emerald-100/70 mt-2">
              No data for this selection.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-4 mt-4 text-sm text-emerald-50">
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">
                  Overall
                </div>
                <div className={`text-xl font-bold ${riskColor}`}>
                  {distribution.overall_level}
                </div>
                <div className="text-xs text-emerald-100/70">
                  Avg score:{" "}
                  {distribution.avg_risk_score !== null
                    ? distribution.avg_risk_score.toFixed(1)
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">
                  Safe
                </div>
                <div className="text-lg font-semibold text-emerald-200">
                  {distribution.safe_count}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">
                  Medium
                </div>
                <div className="text-lg font-semibold text-yellow-300">
                  {distribution.medium_count}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-emerald-200/70">
                  High
                </div>
                <div className="text-lg font-semibold text-red-300">
                  {distribution.high_count} (
                  {(distribution.high_pct * 100).toFixed(1)}%)
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Multi-line trend chart */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Process Trend by PO
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                PO-level lines for cost, lead time, defects, and OEE.
              </p>
            </div>
          </div>

          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">
              Failed to load data: {dataError}
            </div>
          ) : !chartData.length ? (
            <div className="text-xs text-emerald-100/70">
              No data for this selection.
            </div>
          ) : (
            <div className="w-full" style={{ height: 340 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 10, right: 20, left: 10, bottom: 40 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(16,185,129,0.18)"
                  />
                  <XAxis
                    dataKey="po_creation_date"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    angle={-20}
                    height={50}
                  />
                  {/* Left axis for total cost */}
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    tickFormatter={(v) => Number(v).toLocaleString()}
                  />
                  {/* Right axis for lead time, defect qty, and OEE (%) */}
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    tickFormatter={(v) => Number(v).toFixed(0)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#022c22",
                      border: "1px solid rgba(16,185,129,0.4)",
                      borderRadius: "0.75rem",
                      fontSize: "11px",
                      color: "#ECFDF5",
                    }}
                    formatter={(value, name) => {
                      if (
                        value === null ||
                        value === undefined ||
                        Number.isNaN(value)
                      )
                        return "—";
                      if (name === "oee_pct")
                        return [`${Number(value).toFixed(1)}%`, "OEE %"];
                      return [Number(value).toFixed(1), name];
                    }}
                    labelFormatter={(label, payload) => {
                      const po =
                        payload && payload.length
                          ? payload[0].payload.po_number
                          : "";
                      return `${label || "Unknown"} • PO ${po}`;
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: "#ECFDF5" }}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="total_cost"
                    name="Total Cost"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="lead_time_days"
                    name="Lead Time (days)"
                    stroke="#a855f7"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="defect_quantity"
                    name="Defect Qty"
                    stroke="#f97316"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="oee_pct"
                    name="OEE %"
                    stroke="#4ade80"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Geo map */}
        <BubbleSupplyMap nodes={bubbleNodes} filters={filters} />
      </div>
    </section>
  );
}

export default IntegratedDashboard;
