// Import React core and hooks
import React, { useEffect, useMemo, useState } from "react";
// Import configured Supabase client
import supabase from "../lib/supabaseClient";
// Import Recharts components for visualization
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
} from "recharts";

// Main dashboard component; receives onBack callback to return to parent view
function MarketingDashboard({ onBack }) {
  // Raw rows loaded from Supabase view
  const [rows, setRows] = useState([]);
  // Loading state for data fetch
  const [dataLoading, setDataLoading] = useState(true);
  // Error state for data fetch
  const [dataError, setDataError] = useState(null);

  // Filter states for slicers
  const [selectedYear, setSelectedYear] = useState("All");
  const [selectedRegion, setSelectedRegion] = useState("All");
  const [selectedLocation, setSelectedLocation] = useState("All");

  // Load from crm.crm_funnel_view, chunked to avoid Supabase timeouts; keep only needed columns.
  useEffect(() => {
    // Async function to fetch data in chunks
    const loadData = async () => {
      setDataLoading(true);     // start loading
      setDataError(null);       // reset error
      try {
        const chunkSize = 20000;  // number of rows to pull per request
        const maxRows = 140000;   // hard cap to avoid statement timeout / huge payloads
        let offset = 0;           // paging offset
        let aggregated = [];      // accumulator for all fetched rows

        while (true) {
          // Fetch chunk of data from Supabase with schema crm and table crm_funnel_view
          const { data, error } = await supabase
            .schema("crm")
            .from("crm_funnel_view")
            .select(
              [
                "campaign_id",
                "campaign_name",
                "channel",
                "year",
                "marketing_region",
                "marketing_location",
                "budget",
                "spend",
                "leads_generated",
                "leads_converted",
                "start_date",
                "response_time_hours",
                "lead_id",
                "opportunity_id",
                "customer_id",
                "created_date",
                "total_booked_revenue",
                "cac",
                "clv",
              ].join(", ")
            )
            // range uses inclusive start & end index; fetch chunkSize rows
            .range(offset, offset + chunkSize - 1);

          // If Supabase returned an error, fail the whole load
          if (error) {
            throw error;
          }

          // Ensure we always have an array even if data is null
          const batch = data || [];
          // Append current chunk to aggregated array
          aggregated = aggregated.concat(batch);

          // If we got less than chunkSize, we've reached the final page
          // Or if aggregated length reached maxRows, stop to avoid timeouts
          if (batch.length < chunkSize || aggregated.length >= maxRows) {
            break; // last page or safety cap reached
          }

          // Move offset forward for next chunk
          offset += chunkSize;
        }

        // Store all rows in state
        setRows(aggregated);
      } catch (err) {
        // Log error to console for debugging
        console.error(err);
        // Set user-facing error message
        setDataError(err.message ?? "Failed to load data");
      } finally {
        // Stop loading indicator in both success and error cases
        setDataLoading(false);
      }
    };

    // Trigger data load once when component mounts
    loadData();
  }, []);

  // Derive filter options, filtered rows, and all KPIs/visual data from the loaded rows + current filters.
  // useMemo ensures we only recompute when dependencies change.
  const {
    yearOptions,
    regionOptions,
    locationOptions,
    kpiCards,
    revenueMultiple,
    stageCounts,
    top5Channels,
    salesCycle,
    clvCacRatio,
    avgClv,
    avgCac,
  } = useMemo(() => {
    // --------------------
    // BUILD FILTER OPTIONS
    // --------------------

    // Build unique year list from rows:
    // 1) pick year column
    // 2) remove null/undefined/empty
    // 3) normalize to string
    // 4) sort numerically if possible; otherwise lexicographically
    const yearList = Array.from(
      new Set(
        rows
          .map((r) => r.year)
          .filter((v) => v !== null && v !== undefined && v !== "")
          .map((v) => String(v))
      )
    )
      .map((v) => (Number.isNaN(Number(v)) ? v : Number(v))) // cast numeric-looking strings to numbers for proper sorting
      .sort((a, b) => (a > b ? 1 : -1)) // sort ascending
      .map((v) => String(v)); // cast back to string for display and comparisons

    // Region options depend on selected year:
    // Start from all rows, then filter by year if user has selected a specific year.
    let filteredForRegions = rows;
    if (selectedYear !== "All") {
      filteredForRegions = filteredForRegions.filter(
        (row) => String(row.year) === selectedYear
      );
    }

    // Build region list from rows filtered by year.
    const regionList = Array.from(
      new Set(
        filteredForRegions
          .map((r) => r.marketing_region)
          .filter((v) => v !== null && v !== undefined && v !== "")
      )
    ).sort(); // simple alphabetical sort

    // Location options depend on selected year AND region:
    // Start from already year-filtered rows, then filter by region if specified.
    let filteredForLocations = filteredForRegions;
    if (selectedRegion !== "All") {
      filteredForLocations = filteredForLocations.filter(
        (row) => row.marketing_region === selectedRegion
      );
    }

    // Build location list from rows filtered by year + region.
    const locationList = Array.from(
      new Set(
        filteredForLocations
          .map((r) => r.marketing_location)
          .filter((v) => v !== null && v !== undefined && v !== "")
      )
    ).sort();

    // Final filtered rows used for all KPI + chart calculations:
    // They respect year, region, and location selections.
    let filtered = filteredForLocations;
    if (selectedLocation !== "All") {
      filtered = filtered.filter(
        (row) => row.marketing_location === selectedLocation
      );
    }

    // -------------------------------
    // KPI AGGREGATION (dedup campaign)
    // -------------------------------

    // Aggregate variables (global totals across filtered rows)
    let totalSpend = 0;
    let totalBudget = 0;
    let totalRevenue = 0;
    let totalClv = 0;
    let totalCac = 0;
    let clvCount = 0;
    let cacCount = 0;
    let generatedLeads = 0;
    let convertedLeads = 0;
    let oppCount = 0;
    let customerCount = 0;

    // Only calculate metrics if we have finished loading and have no error
    if (!dataLoading && !dataError) {
      // Map keyed by campaign_id to deduplicate spend/budget/leads per campaign
      const marketingByCampaign = new Map();
      // Sets to get distinct opportunity and customer counts
      const opportunityIds = new Set();
      const customerIds = new Set();

      // Loop over all filtered rows
      filtered.forEach((row, idx) => {
        // Revenue is summed row-by-row (no dedup)
        totalRevenue += row.total_booked_revenue || 0;

        // CLV: sum and count only valid numeric values
        if (row.clv !== null && row.clv !== undefined && !Number.isNaN(Number(row.clv))) {
          totalClv += Number(row.clv);
          clvCount += 1;
        }

        // CAC: sum and count only valid numeric values
        if (row.cac !== null && row.cac !== undefined && !Number.isNaN(Number(row.cac))) {
          totalCac += Number(row.cac);
          cacCount += 1;
        }

        // Determine key for marketingByCampaign; fall back to synthetic key if no campaign_id
        const campaignKey =
          row.campaign_id !== null && row.campaign_id !== undefined
            ? row.campaign_id
            : `row-${idx}`;

        // Initialize per-campaign metrics if not present
        if (!marketingByCampaign.has(campaignKey)) {
          marketingByCampaign.set(campaignKey, {
            spend: row.spend || 0,
            budget: row.budget || 0,
            leadsGenerated: row.leads_generated || 0,
            leadsConverted: row.leads_converted || 0,
          });
        }

        // Track distinct opportunities (using Set)
        if (row.opportunity_id) {
          opportunityIds.add(row.opportunity_id);
        }

        // Track distinct customers (using Set)
        if (row.customer_id) {
          customerIds.add(row.customer_id);
        }
      });

      // Aggregate deduplicated campaign-level numbers
      for (const metrics of marketingByCampaign.values()) {
        totalBudget += metrics.budget;
        totalSpend += metrics.spend;
        generatedLeads += metrics.leadsGenerated;
        convertedLeads += metrics.leadsConverted;
      }

      // Distinct counts for opportunities and customers
      oppCount = opportunityIds.size;
      customerCount = customerIds.size;
    }

    // Budget utilization percentage: Spend / Budget
    const budgetUtil =
      totalBudget > 0 ? `${((totalSpend / totalBudget) * 100).toFixed(1)}%` : "—";

    // Revenue multiple: how many dollars of revenue per $1 spend
    const revenueMultiple =
      totalSpend > 0 ? totalRevenue / totalSpend : null;

    // CLV:CAC ratio based on averages: total CLV / total CAC
    const clvCacRatio = totalCac > 0 ? totalClv / totalCac : null;

    // Average CLV and CAC computed from valid records
    const avgClv = clvCount > 0 ? totalClv / clvCount : null;
    const avgCac = cacCount > 0 ? totalCac / cacCount : null;

    // KPI cards for the top row (display-ready objects)
    const cards = [
      {
        id: "spend",
        label: "Total Marketing Spend",
        value: dataLoading
          ? "Loading..."
          : dataError
          ? "—"
          : `$ ${totalSpend.toLocaleString()}`,
        helper: "Sum of campaign spend for the selected filters.",
      },
      {
        id: "revenue",
        label: "Total Revenue",
        value: dataLoading
          ? "Loading..."
          : dataError
          ? "—"
          : `$ ${totalRevenue.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}`,
        helper: "Total booked revenue for the selected filters.",
      },
      {
        id: "budget-utilization",
        label: "Budget Utilization",
        value: dataLoading ? "Loading..." : dataError ? "—" : budgetUtil,
        helper: "Spend vs budget for the selected filters.",
      },
      {
        id: "generated",
        label: "Generated Leads",
        value: dataLoading
          ? "Loading..."
          : dataError
          ? "—"
          : generatedLeads.toLocaleString(),
        helper: "Total leads captured from all campaigns in the selection.",
      },
      {
        id: "converted",
        label: "Converted Leads",
        value: dataLoading
          ? "Loading..."
          : dataError
          ? "—"
          : convertedLeads.toLocaleString(),
        helper: "Leads that converted to opportunities or customers.",
      },
    ];

    // ------------------------------------------------------------
    // TOP 5 CHANNELS BY CONVERSION RATE (unique leads → customers)
    // ------------------------------------------------------------

    // Map of channel -> { channel, leads:Set, customers:Set }
    const channelMap = new Map();

    if (!dataLoading && !dataError) {
      filtered.forEach((row) => {
        // Use "Unknown" if no channel value present
        const ch = row.channel || "Unknown";

        // Initialize stats object per channel
        if (!channelMap.has(ch)) {
          channelMap.set(ch, {
            channel: ch,
            leads: new Set(),
            customers: new Set(),
          });
        }

        const stats = channelMap.get(ch);

        // Track unique lead IDs per channel
        if (row.lead_id) {
          stats.leads.add(row.lead_id);
        }

        // Track unique customer IDs per channel
        if (row.customer_id) {
          stats.customers.add(row.customer_id);
        }
      });
    }

    // Initialize top5Channels array; will be filled if we have enough data
    let top5Channels = [];
    // Initialize structure for sales cycle buckets
    const salesCycleBuckets = { byYear: new Map(), overallSum: 0, overallCount: 0 };

    if (!dataLoading && !dataError) {
      const list = [];

      // Convert channelMap stats into an array with conversion percentages
      channelMap.forEach((stats) => {
        const leads = stats.leads.size;
        const customers = stats.customers.size;

        // Ignore channels with zero leads (cannot compute conversion)
        if (leads === 0) return;

        const conversionPct = (customers / leads) * 100;

        list.push({
          channel: stats.channel,
          leads,
          customers,
          conversionPct,
        });
      });

      // Filter out very small channels (less than 10 leads)
      const filteredList = list.filter((c) => c.leads >= 10);

      // Sort remaining channels by conversion rate in descending order
      filteredList.sort((a, b) => b.conversionPct - a.conversionPct);

      // Keep only the top 5
      top5Channels = filteredList.slice(0, 5);
    }

    // ----------------------------------------
    // SALES CYCLE DURATION (DAYS) PER YEAR
    // start_date -> created_date at customer level
    // ----------------------------------------

    if (!dataLoading && !dataError) {
      // Set to deduplicate by customer; we only want one cycle per customer
      const seenCustomer = new Set();

      filtered.forEach((row, idx) => {
        // Require both start_date and created_date to compute duration
        if (!row.start_date || !row.created_date) return;

        // Use customer_id if present, else fallback to row index-based key
        const custKey =
          row.customer_id !== null && row.customer_id !== undefined
            ? row.customer_id
            : `row-${idx}`;

        // Skip if we've already processed this customer
        if (seenCustomer.has(custKey)) return;
        seenCustomer.add(custKey);

        // Parse dates from row fields
        const start = new Date(row.start_date);
        const end = new Date(row.created_date);

        // If dates are invalid, skip this row
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;

        // Compute duration in days (non-negative)
        const days = Math.max(0, (end.getTime() - start.getTime()) / 86400000);

        // Determine year bucket (fallback to "Unknown" if missing)
        const yearKey = row.year ?? "Unknown";

        // Initialize year bucket if not present
        if (!salesCycleBuckets.byYear.has(yearKey)) {
          salesCycleBuckets.byYear.set(yearKey, { sum: 0, count: 0 });
        }

        // Add current duration into year's sum and increment count
        const bucket = salesCycleBuckets.byYear.get(yearKey);
        bucket.sum += days;
        bucket.count += 1;

        // Track overall sum and count for aggregate average
        salesCycleBuckets.overallSum += days;
        salesCycleBuckets.overallCount += 1;
      });
    }

    // Return all computed data; useMemo will memoize this object
    return {
      // Filter option arrays include "All" sentinel at the start
      yearOptions: ["All", ...yearList],
      regionOptions: ["All", ...regionList],
      locationOptions: ["All", ...locationList],
      // KPI card definitions
      kpiCards: cards,
      // Revenue multiple for bar-like gauge
      revenueMultiple,
      // Funnel stage counts
      stageCounts: {
        generated: generatedLeads,
        converted: convertedLeads,
        opportunities: oppCount,
        customers: customerCount,
      },
      // Top 5 channels array for bar chart
      top5Channels,
      // Sales cycle metrics (per year and overall)
      salesCycle: salesCycleBuckets,
      // CLV/CAC metrics
      clvCacRatio,
      avgClv,
      avgCac,
    };
  }, [
    // Dependencies for useMemo: recalc when any of these change
    rows,
    selectedYear,
    selectedRegion,
    selectedLocation,
    dataLoading,
    dataError,
  ]);

  // ----------------
  // JSX RENDER BLOCK
  // ----------------
  return (
    <section className="max-w-7xl mx-auto mt-10">
      {/* Outer container with rounded frame and background */}
      <div className="rounded-3xl border border-emerald-500/30 bg-black/20 px-5 py-6 shadow-emerald-900/40 shadow-2xl backdrop-blur-md md:px-8 md:py-8">
        {/* Top bar with back button + breadcrumb */}
        <div className="flex items-center justify-between gap-4">
          {/* Back button to parent dashboard */}
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 text-sm text-emerald-100 hover:text-emerald-50
                       border border-emerald-400/40 rounded-full px-3 py-1 bg-emerald-900/40
                       hover:bg-emerald-800/60 transition"
          >
            <span className="text-lg leading-none">←</span>
            <span>Back to dashboard</span>
          </button>

          {/* Simple breadcrumb text */}
          <div className="text-xs text-emerald-100/70">
            Home / CRM Analytics /{" "}
            <span className="text-emerald-50">
              Marketing &amp; Campaign Effectiveness
            </span>
          </div>
        </div>

        {/* Module header section */}
        <div className="mt-6">
          {/* Tag indicating CRM module */}
          <p className="inline-flex items-center gap-2 rounded-full bg-emerald-900/60 border border-emerald-400/40 px-4 py-1 text-xs text-emerald-100">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
            CRM Module
          </p>
          {/* Main title */}
          <h2 className="mt-3 text-2xl md:text-3xl font-bold text-white tracking-tight">
            Integrated Funnel KPIs: Spend to Revenue, Leads to Customers
          </h2>
          {/* Subtitle / description */}
          <p className="mt-2 text-sm text-emerald-100/80 max-w-2xl">
            See where marketing spend turns into revenue, which regions convert
            fastest, and where the funnel slows down slice by year, region, and
            location to guide the next investment move.
          </p>
        </div>

        {/* Error message if data failed to load */}
        {dataError && (
          <p className="mt-4 text-xs text-red-200">
            Failed to load data: {dataError}
          </p>
        )}

        {/* FILTER BAR */}
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {/* Year filter dropdown */}
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

          {/* Region filter dropdown */}
          <div className="flex flex-col">
            <label className="text-xs text-emerald-100/80 mb-1">Region</label>
            <select
              value={selectedRegion}
              onChange={(e) => setSelectedRegion(e.target.value)}
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

          {/* Location filter dropdown */}
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

        {/* KPI CARDS ROW */}
        <div className="mt-8 grid gap-6 grid-cols-1 md:grid-cols-5">
          {kpiCards.map((kpi, index) => (
            <div
              key={kpi.id}
              className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-5 shadow-lg backdrop-blur-sm
                         flex flex-col justify-between
                         hover:border-emerald-300 hover:shadow-emerald-400/30 transition-all duration-300
                         hover:-translate-y-1"
              style={{
                // CSS animation for fade-in staggered effect
                animation: "fadeInUp 0.9s ease-out forwards",
                animationDelay: `${0.15 * (index + 1)}s`,
              }}
            >
              {/* KPI label */}
              <p className="text-xs uppercase tracking-wide text-emerald-200/80">
                {kpi.label}
              </p>
              {/* KPI value */}
              <p className="mt-3 text-xl md:text-2xl font-semibold text-white leading-tight break-words">
                {kpi.value}
              </p>
              {/* Helper text */}
              <p className="mt-3 text-xs text-emerald-100/70">{kpi.helper}</p>
            </div>
          ))}
        </div>

        {/* Revenue multiple visual (horizontal gauge bar) */}
        <div className="mt-8 bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Revenue per Marketing Dollar
              </h3>
              <p className="mt-1 text-xs text-emerald-100/70">
                Shows how many dollars of booked revenue you’re earning for each
                dollar of marketing spend with these filters.
              </p>
            </div>
            {/* Numeric display for revenue multiple */}
            <div className="text-2xl font-bold text-white">
              {dataLoading ||
              dataError ||
              revenueMultiple === null ||
              Number.isNaN(revenueMultiple)
                ? "—"
                : `${revenueMultiple.toFixed(1)}×`}
            </div>
          </div>

          {/* Gauge-like bar */}
          <div className="mt-4">
            <div className="w-full h-3 rounded-full bg-emerald-900/60 border border-emerald-500/40 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-400 via-emerald-300 to-emerald-200"
                style={{
                  // Width is scaled linearly vs a 25x cap
                  width:
                    dataLoading ||
                    dataError ||
                    revenueMultiple === null ||
                    Number.isNaN(revenueMultiple)
                      ? "0%"
                      : `${Math.min((revenueMultiple / 25) * 100, 100)}%`,
                  transition: "width 0.4s ease, background 0.4s ease",
                }}
              />
            </div>
            {/* Gauge labels */}
            <div className="mt-2 flex justify-between text-[11px] text-emerald-100/70">
              <span>0×</span>
              <span>25× (capped)</span>
            </div>
          </div>
        </div>

        {/* Split row: Funnel (left) + Top 5 Channels (right) */}
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {/* Funnel graphic section */}
          <div className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Funnel Progression
                </h3>
                <p className="mt-1 text-xs text-emerald-100/70">
                  Leads flowing to conversions, opportunities, and customers
                  with current filters.
                </p>
              </div>
            </div>

            {/* Custom funnel style using divs with clipPath */}
            {stageCounts && (
              <div className="flex flex-col items-center gap-3">
                {(() => {
                  // Stages in funnel order
                  const stages = [
                    {
                      id: "generated",
                      label: "Leads Generated",
                      value: stageCounts.generated,
                    },
                    {
                      id: "converted",
                      label: "Leads Converted",
                      value: stageCounts.converted,
                    },
                    {
                      id: "opps",
                      label: "Opportunities",
                      value: stageCounts.opportunities,
                    },
                    {
                      id: "customers",
                      label: "Customers",
                      value: stageCounts.customers,
                    },
                  ];
                  // Colors used for each stage bar
                  const colors = ["#16a34a", "#2dd4bf", "#0ea5e9", "#6366f1"];
                  // Top stage value used for relative width scaling
                  const topValue = Math.max(
                    stages[0] && Number.isFinite(stages[0].value)
                      ? stages[0].value
                      : 0,
                    1
                  );

                  // Map each stage to its bar representation
                  return stages.map((stage, idx) => {
                    // Previous stage value for percentage calculation
                    const prevVal =
                      idx === 0 || !Number.isFinite(stages[idx - 1].value)
                        ? null
                        : stages[idx - 1].value;

                    // Conversion ratio from previous stage to current
                    const ratio =
                      prevVal &&
                      prevVal > 0 &&
                      Number.isFinite(stage.value)
                        ? (stage.value / prevVal) * 100
                        : null;

                    // Width percentage of bar based on relative value
                    const widthPct =
                      dataLoading ||
                      dataError ||
                      !Number.isFinite(stage.value)
                        ? 0
                        : Math.max(
                            18, // minimum visible width
                            Math.min((stage.value / topValue) * 100, 100)
                          );

                    // Color picked from array
                    const color = colors[idx % colors.length];

                    return (
                      <div
                        key={stage.id}
                        className="relative text-center text-white font-semibold"
                        style={{ width: `${widthPct}%`, minWidth: "140px" }}
                      >
                        <div
                          className="mx-auto py-4 rounded-md"
                          style={{
                            backgroundColor: color,
                            // Use trapezoid clipPath for all except the last stage
                            clipPath:
                              idx === stages.length - 1
                                ? "polygon(0 0, 100% 0, 100% 100%, 0 100%)"
                                : "polygon(0 0, 100% 0, 80% 100%, 20% 100%)",
                          }}
                        >
                          {/* Stage value */}
                          <div className="text-lg">
                            {dataLoading
                              ? "Loading..."
                              : dataError
                              ? "—"
                              : stage.value.toLocaleString()}
                          </div>
                          {/* Stage label */}
                          <div className="text-xs font-normal mt-1 text-white/90">
                            {stage.label}
                          </div>
                          {/* Conversion from prior stage */}
                          <div className="text-[11px] font-normal mt-1 text-white/80">
                            {idx === 0
                              ? "Starting volume"
                              : dataLoading ||
                                dataError ||
                                ratio === null ||
                                Number.isNaN(ratio)
                              ? "—"
                              : `${ratio.toFixed(1)}% from prior`}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>

          {/* Top 5 Channels by Conversion Rate - Vertical Bar Chart */}
          <div className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-7 shadow-lg backdrop-blur-sm">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Top 5 Channels by Conversion Rate
                </h3>
                <p className="mt-1 text-xs text-emerald-100/70 max-w-xs">
                  Lead-to-customer conversion rate by marketing channel with the
                  current filters applied.
                </p>
              </div>
            </div>

            {/* Chart state handling: loading / error / no data / chart */}
            {dataLoading ? (
              <div className="text-xs text-emerald-100/70">Loading…</div>
            ) : dataError ? (
              <div className="text-xs text-red-200">
                Unable to compute channel conversion.
              </div>
            ) : !top5Channels.length ? (
              <div className="text-xs text-emerald-100/70">
                No channels with sufficient leads for this filter selection.
              </div>
            ) : (
              <div className="w-full" style={{ height: 360 }}>
                {/* Responsive container for bar chart */}
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={top5Channels}
                    margin={{ top: 10, right: 20, left: 10, bottom: 50 }}
                  >
                    {/* Grid with dashed horizontal lines only */}
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(16, 185, 129, 0.18)"
                      vertical={false}
                    />
                    {/* X-axis: channel names */}
                    <XAxis
                      dataKey="channel"
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={50}
                      tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    />
                    {/* Y-axis: conversion percentage */}
                    <YAxis
                      tickFormatter={(v) => `${v}%`}
                      tick={{ fontSize: 11, fill: "#A7F3D0" }}
                    />
                    {/* Tooltip formatting for values and label */}
                    <Tooltip
                      cursor={{ fill: "rgba(16, 185, 129, 0.12)" }}
                      contentStyle={{
                        backgroundColor: "#022c22",
                        border: "1px solid rgba(16,185,129,0.4)",
                        borderRadius: "0.75rem",
                        fontSize: "11px",
                        color: "#ECFDF5",
                      }}
                      formatter={(value, name) =>
                        name === "conversionPct"
                          ? [`${value.toFixed(1)}%`, "Conversion Rate"]
                          : [value, name]
                      }
                      labelFormatter={(label, payload) => {
                        // Use first payload element to extract extra info
                        if (!payload || !payload.length) return label;
                        const d = payload[0].payload;
                        return `${d.channel} • ${d.customers.toLocaleString()} customers from ${d.leads.toLocaleString()} leads`;
                      }}
                    />
                    {/* Single bar series for conversionPct */}
                    <Bar
                      dataKey="conversionPct"
                      fill="#34D399"
                      radius={[4, 4, 0, 0]}
                    >
                      {/* Value labels on top of each bar */}
                      <LabelList
                        dataKey="conversionPct"
                        position="top"
                        formatter={(v) => `${v.toFixed(1)}%`}
                        fill="#ECFDF5"
                        fontSize={11}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>

        {/* Sales Cycle + CLV/CAC side-by-side */}
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {/* Sales Cycle Duration summary */}
          <div className="bg-gradient-to-r from-emerald-900/70 via-emerald-800/60 to-emerald-900/70 border border-emerald-500/40 rounded-3xl p-6 shadow-lg backdrop-blur-sm">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  Sales Cycle Duration
                </h3>
                <p className="mt-1 text-xs text-emerald-100/80">
                  Avg days from campaign start to customer creation (filter-aware).
                </p>
                {/* Year-wise breakdown (up to last 4 years) */}
                {!dataLoading && !dataError && salesCycle.byYear.size > 0 && (
                  <div className="mt-3 grid grid-cols-2 gap-3 text-[12px] text-emerald-100/80">
                    {Array.from(salesCycle.byYear.entries())
                      // Map data into { year, avg } objects
                      .map(([year, v]) => ({
                        year: String(year),
                        avg: v.count > 0 ? v.sum / v.count : 0,
                      }))
                      // Sort years numerically when possible
                      .sort((a, b) => {
                        const na = Number(a.year);
                        const nb = Number(b.year);
                        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
                        return a.year.localeCompare(b.year);
                      })
                      .map((item) => (
                        <div
                          key={item.year}
                          className="rounded-xl border border-emerald-500/30 bg-black/10 px-3 py-2"
                        >
                          <div className="text-[11px] text-emerald-100/70">
                            {item.year}
                          </div>
                          <div className="text-sm font-semibold text-white">
                            {item.avg.toFixed(1)} days
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
              {/* Overall sales cycle average */}
              <div className="min-w-[180px] text-right">
                <div className="text-xs uppercase tracking-wide text-emerald-200/80">
                  Overall avg
                </div>
                <div className="text-3xl font-bold text-white mt-1">
                  {dataLoading ||
                  dataError ||
                  salesCycle.overallCount === 0
                    ? "—"
                    : `${(salesCycle.overallSum / salesCycle.overallCount).toFixed(1)}d`}
                </div>
              </div>
            </div>
            {/* State messages */}
            {dataLoading ? (
              <div className="mt-3 text-xs text-emerald-100/70">Loading…</div>
            ) : dataError ? (
              <div className="mt-3 text-xs text-red-200">
                Unable to load sales cycle duration.
              </div>
            ) : salesCycle.byYear.size === 0 ? (
              <div className="mt-3 text-xs text-emerald-100/70">
                No sales cycle data for this filter selection.
              </div>
            ) : null}
          </div>

          {/* CLV : CAC Summary card */}
          <div className="bg-[#0b1210]/70 border border-emerald-500/40 rounded-2xl p-6 shadow-lg backdrop-blur-sm">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-white">CLV vs CAC</h3>
                <p className="mt-1 text-xs text-emerald-100/70">
                  Averages based on current filters; ratio shows return per acquisition dollar.
                </p>
              </div>
              {/* CLV:CAC ratio */}
              <div className="text-2xl font-bold text-white">
                {dataLoading || dataError || clvCacRatio === null || Number.isNaN(clvCacRatio)
                  ? "—"
                  : `${clvCacRatio.toFixed(2)}×`}
              </div>
            </div>
            {/* 3 small cards for Avg CLV, Avg CAC, and ratio */}
            <div className="grid gap-3 sm:grid-cols-3">
              {/* Avg CLV */}
              <div className="rounded-xl border border-emerald-500/30 bg-black/10 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-emerald-200/80">
                  Avg CLV
                </div>
                <div className="mt-2 text-xl font-semibold text-white">
                  {dataLoading || dataError || avgClv === null || Number.isNaN(avgClv)
                    ? "—"
                    : `$${Math.round(avgClv).toLocaleString()}`}
                </div>
              </div>
              {/* Avg CAC */}
              <div className="rounded-xl border border-emerald-500/30 bg-black/10 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-emerald-200/80">
                  Avg CAC
                </div>
                <div className="mt-2 text-xl font-semibold text-white">
                  {dataLoading || dataError || avgCac === null || Number.isNaN(avgCac)
                    ? "—"
                    : `$${Math.round(avgCac).toLocaleString()}`}
                </div>
              </div>
              {/* CLV:CAC ratio */}
              <div className="rounded-xl border border-emerald-500/30 bg-black/10 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-emerald-200/80">
                  CLV : CAC
                </div>
                <div className="mt-2 text-xl font-semibold text-white">
                  {dataLoading || dataError || clvCacRatio === null || Number.isNaN(clvCacRatio)
                    ? "—"
                    : `${clvCacRatio.toFixed(2)}×`}
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

// Export component as default
export default MarketingDashboard;
