import React, { useEffect, useMemo, useState } from "react";
import supabase from "../lib/supabaseClient";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Line,
  ScatterChart,
  Scatter,
  ZAxis,
} from "recharts";

// Integrated KPI view (CRM + ERP) without filters.
// Computes the four requested KPIs client-side from crm.crm_erp_funnel_view:
// 1) Customer True Profitability
// 2) Gross Margin %
// 3) Lead-to-Delivery Cycle Time (avg days)
// 4) CLV : CAC Ratio
//
// Assumed columns in the view:
// - customer_id
// - revenue_recognized_to_date
// - total_cost                  (procurement total_cost, per row)
// - last_movement_date          (inventory "delivery" timestamp)
// - contact_date                (lead first contact)
// - clv
// - cac
//
// Logic:
// - Aggregate per customer:
//     revenue sum, supply_chain_cost sum, earliest contact_date,
//     earliest delivery_date, clv, cac
// - KPIs:
//     customer_profit = sum(revenue) - sum(cost)
//     gross_margin_pct = customer_profit / sum(revenue)
//     lead_to_delivery_days = avg( earliest_delivery - earliest_contact ) over customers with both dates
//     clv_cac_ratio = avg( clv / cac ) over customers with cac > 0

function IntegratedDashboard({ onBack }) {
  const [rows, setRows] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);

  useEffect(() => {
    const loadData = async () => {
      setDataLoading(true);
      setDataError(null);
      try {
        // Pull in chunks to avoid timeouts, but target full dataset (no hard cap)
        const chunkSize = 20000;
        let offset = 0;
        let aggregated = [];

        while (true) {
          const { data, error } = await supabase
            .schema("crm")
            .from("crm_erp_funnel_view")
            .select(
              [
                "customer_id",
                "customer_name",
                "crm_region",
                "customer_industry",
                "revenue_recognized_to_date",
                "total_booked_revenue",
                "total_supply_chain_cost",
                "lead_to_delivery_days",
                "customer_profit",
                "gross_margin_pct",
                "inventory_last_movement_date",
                "first_contact_date",
                "clv",
                "cac",
                "campaign_id",
                "campaign_name",
                "campaign_spend",
                "campaign_type",
                "size_bucket",
                "customer_industry",
                "on_time_ratio",
                "avg_lead_time_days",
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

  const { kpiCards, campaignRoiData, fmtCurrency, segmentReliability, bubbleData } = useMemo(() => {
    const customers = new Map();
    const campaigns = new Map();
    const segments = new Map(); // size_bucket or industry -> aggregates

    rows.forEach((r) => {
      const id = r.customer_id ?? "unknown";
      if (!customers.has(id)) {
        customers.set(id, {
          customerName: r.customer_name || id,
          crmRegion: r.crm_region || "Unknown",
          industry: r.customer_industry || "Unknown",
          revenue: 0,
          booked: 0,
          cost: 0,
          contact: null,
          delivery: null, // inventory_last_movement_date fallback
          leadToDeliveryDays: null, // use precomputed when present
          clv: null,
          cac: null,
          customerProfit: null,
          grossMarginPct: null,
          onTimeRatio: null,
        });
      }
      const c = customers.get(id);
      const rev = Number(r.revenue_recognized_to_date);
      if (!Number.isNaN(rev)) c.revenue += rev;

      const booked = Number(r.total_booked_revenue);
      if (!Number.isNaN(booked)) c.booked += booked;

      const cost = Number(r.total_supply_chain_cost);
      if (!Number.isNaN(cost)) c.cost += cost;

      if (r.customer_profit !== null && r.customer_profit !== undefined) {
        const cp = Number(r.customer_profit);
        if (!Number.isNaN(cp)) c.customerProfit = (c.customerProfit ?? 0) + cp;
      }

      if (r.gross_margin_pct !== null && r.gross_margin_pct !== undefined) {
        const gm = Number(r.gross_margin_pct);
        if (!Number.isNaN(gm)) c.grossMarginPct = gm;
      }

      if (r.first_contact_date) {
        const d = new Date(r.first_contact_date);
        if (!Number.isNaN(d.getTime())) {
          if (!c.contact || d < c.contact) c.contact = d;
        }
      }

      if (r.inventory_last_movement_date) {
        const d = new Date(r.inventory_last_movement_date);
        if (!Number.isNaN(d.getTime())) {
          if (!c.delivery || d < c.delivery) c.delivery = d;
        }
      }

      if (r.lead_to_delivery_days !== null && r.lead_to_delivery_days !== undefined) {
        const ltd = Number(r.lead_to_delivery_days);
        if (!Number.isNaN(ltd)) c.leadToDeliveryDays = ltd;
      }

      const clv = Number(r.clv);
      if (!Number.isNaN(clv)) c.clv = clv;

      const cac = Number(r.cac);
      if (!Number.isNaN(cac)) c.cac = cac;

      // Campaign aggregation
      if (r.campaign_type) {
        const cid = r.campaign_type;
        if (!campaigns.has(cid)) {
          campaigns.set(cid, {
            campaign_id: cid,
            campaign_name: r.campaign_type || cid,
            revenue: 0,
            cost: 0,
            spend: 0,
          });
        }
        const camp = campaigns.get(cid);
        if (!Number.isNaN(rev)) camp.revenue += rev;
        if (!Number.isNaN(cost)) camp.cost += cost;
        const spend = Number(r.campaign_spend);
        if (!Number.isNaN(spend)) camp.spend += spend;
      }

      // Segment aggregation (size bucket preferred, fallback industry)
      const segKey = r.size_bucket || r.customer_industry || "Unknown";
      if (!segments.has(segKey)) {
        segments.set(segKey, { segment: segKey, onTimeSum: 0, onTimeCount: 0, leadTimeSum: 0, leadTimeCount: 0 });
      }
      const seg = segments.get(segKey);
      if (r.on_time_ratio !== null && r.on_time_ratio !== undefined) {
        const val = Number(r.on_time_ratio);
        if (!Number.isNaN(val)) {
          seg.onTimeSum += val;
          seg.onTimeCount += 1;
        }
      }
      if (r.avg_lead_time_days !== null && r.avg_lead_time_days !== undefined) {
        const val = Number(r.avg_lead_time_days);
        if (!Number.isNaN(val)) {
          seg.leadTimeSum += val;
          seg.leadTimeCount += 1;
        }
      }

      if (r.on_time_ratio !== null && r.on_time_ratio !== undefined) {
        const otr = Number(r.on_time_ratio);
        if (!Number.isNaN(otr)) {
          c.onTimeRatio = otr;
        }
      }
    });

    let totalRevenue = 0;
    let leadDeliverySum = 0;
    let leadDeliveryCount = 0;
    let clvCacSum = 0;
    let clvCacCount = 0;

    customers.forEach((c) => {
      totalRevenue += c.revenue;

      if (c.leadToDeliveryDays !== null && c.leadToDeliveryDays !== undefined) {
        const diff = Number(c.leadToDeliveryDays);
        if (Number.isFinite(diff)) {
          leadDeliverySum += diff;
          leadDeliveryCount += 1;
        }
      } else if (c.contact && c.delivery) {
        const diffDays = (c.delivery - c.contact) / (1000 * 60 * 60 * 24);
        if (Number.isFinite(diffDays)) {
          leadDeliverySum += diffDays;
          leadDeliveryCount += 1;
        }
      }

      if (c.cac && c.cac > 0 && c.clv !== null && c.clv !== undefined) {
        const ratio = c.clv / c.cac;
        if (Number.isFinite(ratio)) {
          clvCacSum += ratio;
          clvCacCount += 1;
        }
      }
    });

    const customerProfit = customers.size
      ? Array.from(customers.values()).reduce((sum, c) => {
          if (c.customerProfit !== null && c.customerProfit !== undefined) {
            return sum + c.customerProfit;
          }
          return sum + (c.revenue - c.cost);
        }, 0)
      : 0;

    const grossMarginPct =
      totalRevenue > 0
        ? ((customerProfit) / totalRevenue) * 100
        : null;
    const leadToDelivery =
      leadDeliveryCount > 0 ? leadDeliverySum / leadDeliveryCount : null;
    const clvCacRatio = clvCacCount > 0 ? clvCacSum / clvCacCount : null;

    // Customer margin data for chart
    // Campaign ROI data for chart
    const campaignRoiData = Array.from(campaigns.values())
      .map((c) => {
        const spend = c.spend || 0;
        const profit = c.revenue - c.cost - spend;
        const roi = spend > 0 ? (profit / spend) * 100 : null;
        return {
          name: c.campaign_name,
          roi,
          profit,
          profitTrend: profit,
        };
      })
      .filter((d) => d.roi !== null && Number.isFinite(d.roi) && d.roi > 0)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);

    const segmentReliability = Array.from(segments.values())
      .map((s) => ({
        segment: s.segment,
        onTimePct: s.onTimeCount > 0 ? s.onTimeSum * 100 / s.onTimeCount : null,
        leadTime: s.leadTimeCount > 0 ? s.leadTimeSum / s.leadTimeCount : null,
      }))
      .filter((s) => s.onTimePct !== null && Number.isFinite(s.onTimePct))
      .sort((a, b) => b.onTimePct - a.onTimePct);

    const bubbleData = Array.from(customers.values())
      .map((c) => ({
        name: c.customerName,
        region: c.crmRegion || c.industry || "Unknown",
        industry: c.industry || "Unknown",
        onTime: c.onTimeRatio,
        profit: c.customerProfit ?? c.revenue - c.cost,
        revenue: c.booked,
      }))
      .filter(
        (d) =>
          d.onTime !== null &&
          d.onTime !== undefined &&
          Number.isFinite(Number(d.onTime)) &&
          d.profit !== null &&
          d.profit !== undefined &&
          Number.isFinite(Number(d.profit)) &&
          d.revenue !== null &&
          d.revenue !== undefined &&
          Number.isFinite(Number(d.revenue))
      );

    const fmtCurrency = (val) => {
      if (typeof val !== "number" || !Number.isFinite(val)) return "—";
      const abs = Math.abs(val);
      if (abs >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
      if (abs >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
      return Math.round(val).toLocaleString();
    };
    const fmtPct = (val) =>
      typeof val === "number" ? `${val.toFixed(1)}%` : "—";
    const fmtDays = (val) =>
      typeof val === "number" ? `${val.toFixed(1)} days` : "—";
    const fmtRatio = (val) =>
      typeof val === "number" ? `${val.toFixed(2)}×` : "—";

    return {
      kpiCards: [
        {
          id: "profit",
          label: "Customer True Profitability",
          value: dataLoading || dataError ? "—" : fmtCurrency(customerProfit),
          helper: "Revenue recognized minus total supply chain cost.",
        },
        {
          id: "gm",
          label: "Gross Margin %",
          value: dataLoading || dataError ? "—" : fmtPct(grossMarginPct),
          helper: "Profit as a percent of recognized revenue.",
        },
        {
          id: "cycle",
          label: "Lead-to-Inventory Ready",
          value: dataLoading || dataError ? "—" : fmtDays(leadToDelivery),
          helper: "Average days from first contact until inventory is available/shipped.",
        },
        {
          id: "clv-cac",
          label: "CLV : CAC Ratio",
          value: dataLoading || dataError ? "—" : fmtRatio(clvCacRatio),
          helper: "Average CLV divided by CAC across customers.",
        },
      ],
      campaignRoiData,
      fmtCurrency,
      segmentReliability,
      bubbleData,
    };
  }, [rows, dataLoading, dataError]);

  return (
    <section className="max-w-6xl mx-auto mt-10">
      <div className="rounded-3xl border border-emerald-500/30 bg-black/20 px-5 py-6 shadow-emerald-900/40 shadow-2xl backdrop-blur-md md:px-8 md:py-8">
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
            Cross-System Profit &amp; Cycle KPIs
          </h2>
          <p className="mt-2 text-sm text-emerald-100/80 max-w-2xl">
            Unified profitability, margin, lead-to-delivery cycle, and CLV:CAC ratio calculated across CRM and ERP.
          </p>
        </div>

        {dataError && (
          <p className="mt-4 text-xs text-red-200">
            Failed to load data: {dataError}
          </p>
        )}

        <div className="mt-8 grid gap-6 grid-cols-1 md:grid-cols-2">
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
              <p className="mt-3 text-2xl font-semibold text-white">{kpi.value}</p>
              <p className="mt-3 text-xs text-emerald-100/70">{kpi.helper}</p>
            </div>
          ))}
        </div>


        <div className="mt-8 grid gap-6 grid-cols-1 md:grid-cols-2">
          {/* Campaign Profit Bar Chart */}
          <div className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Campaign Profit by Type (2020–2025)</h3>
            <p className="mt-1 text-xs text-emerald-100/70">
              Profit after supply-chain cost and campaign spend across 2020–2025; hover to see ROI%.
            </p>
              </div>
            </div>
            {dataLoading ? (
              <div className="text-xs text-emerald-100/70">Loading…</div>
            ) : dataError ? (
              <div className="text-xs text-red-200">Unable to load campaign profit.</div>
            ) : !campaignRoiData?.length ? (
              <div className="text-xs text-emerald-100/70">No campaign profit data available.</div>
            ) : (
              <div className="w-full" style={{ height: 340 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={campaignRoiData}
                    margin={{ top: 10, right: 20, left: 10, bottom: 60 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(16,185,129,0.18)" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10, fill: "#A7F3D0" }}
                      angle={-25}
                      textAnchor="end"
                      interval={0}
                      height={60}
                    />
                    <YAxis
                      tickFormatter={(v) => fmtCurrency(v)}
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
                      formatter={(value, name, props) => {
                        if (props?.dataKey === "profitTrend") {
                          return null; // hide line series in tooltip
                        }
                        if (name === "profit") {
                          return [fmtCurrency(value), "Profit After Cost & Spend"];
                        }
                        return [value, name];
                      }}
                      filterNull
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 11, color: "#A7F3D0" }}
                      formatter={(val) => (val === "profit" ? "Profit" : val)}
                    />
                    <Bar
                      dataKey="profit"
                      radius={[4, 4, 0, 0]}
                      fill="#f59e0b"
                      shape={(props) => {
                        const { x, y, width, height, payload } = props;
                        const color = payload.profit < 0 ? "#ef4444" : "#f59e0b";
                        return <rect x={x} y={y} width={width} height={height} fill={color} />;
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="profitTrend"
                      name="Trend"
                      stroke="#22d3ee"
                      strokeWidth={2}
                      dot={{ r: 3, stroke: "#22d3ee", fill: "#0f172a" }}
                      activeDot={{ r: 5, fill: "#22d3ee" }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
          )}
        </div>

        {/* Customer Delivery Reliability Matrix (Grouped Bar) */}
          <div className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-white">Customer Delivery Reliability</h3>
                <p className="mt-1 text-xs text-emerald-100/70">
                  On-time delivery % by customer segment (size/industry) with lead time context.
                </p>
              </div>
            </div>
            {dataLoading ? (
              <div className="text-xs text-emerald-100/70">Loading…</div>
            ) : dataError ? (
              <div className="text-xs text-red-200">Unable to load delivery reliability.</div>
            ) : !segmentReliability?.length ? (
              <div className="text-xs text-emerald-100/70">No delivery reliability data available.</div>
            ) : (
              <div className="w-full" style={{ height: 340 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={segmentReliability}
                    margin={{ top: 10, right: 20, left: 10, bottom: 60 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(16,185,129,0.18)" />
                    <XAxis
                      dataKey="segment"
                      tick={{ fontSize: 10, fill: "#A7F3D0" }}
                      angle={-20}
                      textAnchor="end"
                      interval={0}
                      height={60}
                    />
                    <YAxis
                      tickFormatter={(v) => `${v.toFixed(1)}%`}
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
                      formatter={(value, name, props) => {
                        if (name === "onTimePct") return [`${value.toFixed(1)}%`, "On-Time %"];
                        if (name === "leadTime") return [`${value.toFixed(1)} days`, "Avg Lead Time"];
                        return [value, name];
                      }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 11, color: "#A7F3D0" }}
                      formatter={(val) => (val === "onTimePct" ? "On-Time %" : "Avg Lead Time")}
                    />
                    <Bar
                      dataKey="onTimePct"
                      radius={[4, 4, 0, 0]}
                      fill="#34d399"
                      shape={(props) => {
                        const { x, y, width, height, payload } = props;
                        // Color adjust by lead time: greener for shorter, more teal for longer
                        const lt = payload.leadTime ?? 0;
                        const clamped = Math.max(0, Math.min(60, lt)); // clamp 0-60 days
                        const green = 210 - clamped * 2; // reduce green as lead time increases
                        const color = `rgba(52, ${green}, 153, 1)`;
                        return <rect x={x} y={y} width={width} height={height} fill={color} />;
                      }}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
          )}
        </div>

        {/* Customer Profit vs Delivery Reliability (Bubble) */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Customer Profit vs Delivery Reliability
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                On-time ratio vs customer profit; bubble size = booked revenue, color = region/industry.
              </p>
            </div>
          </div>
          {dataLoading ? (
            <div className="text-xs text-emerald-100/70">Loading…</div>
          ) : dataError ? (
            <div className="text-xs text-red-200">Unable to load bubble data.</div>
          ) : !bubbleData?.length ? (
            <div className="text-xs text-emerald-100/70">No data available.</div>
          ) : (
            <div className="w-full" style={{ height: 340 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(16,185,129,0.18)" />
                  <XAxis
                    type="number"
                    dataKey="onTime"
                    name="On-Time Ratio"
                    tickFormatter={(v) => `${(v * 100).toFixed(1)}%`}
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    domain={[0, 1]}
                  />
                  <YAxis
                    type="number"
                    dataKey="profit"
                    name="Customer Profit"
                    tickFormatter={(v) => fmtCurrency(v)}
                    tick={{ fontSize: 11, fill: "#A7F3D0" }}
                  />
                  <ZAxis dataKey="revenue" range={[40, 180]} name="Booked Revenue" />
                  <Tooltip
                    cursor={{ stroke: "rgba(16,185,129,0.4)" }}
                    contentStyle={{
                      backgroundColor: "#022c22",
                      border: "1px solid rgba(16,185,129,0.4)",
                      borderRadius: "0.75rem",
                      fontSize: "11px",
                      color: "#ECFDF5",
                    }}
                    formatter={(value, name, props) => {
                      if (name === "onTime") return [`${(value * 100).toFixed(1)}%`, "On-Time Ratio"];
                      if (name === "profit") return [fmtCurrency(value), "Customer Profit"];
                      if (name === "revenue") return [fmtCurrency(value), "Booked Revenue"];
                      return [value, name];
                    }}
                    labelFormatter={() => ""}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: "#A7F3D0" }}
                    formatter={() => "Region/Industry bubbles (size = revenue)"}
                  />
                  <Scatter
                    data={bubbleData}
                    fill="#34d399"
                    stroke="#0ea5e9"
                    fillOpacity={0.6}
                    shape="circle"
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        </div>
      </div>
    </section>
  );
}

export default IntegratedDashboard;
