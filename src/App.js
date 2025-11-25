import React, { useState } from "react";
import MarketingDashboard from "./pages/MarketingDashboard";
import ERPDashboard from "./pages/ERPDashboard";

const VIEWS = {
  LANDING: "landing",
  CRM_MARKETING: "crm-marketing",
  ERP: "erp",
};

function App() {
  const [activeArea, setActiveArea] = useState(null); // "crm" | "erp" | null
  const [view, setView] = useState(VIEWS.LANDING);

  const handleAreaClick = (id) => {
    // toggle selection on landing; reset view when switching away
    if (id !== "crm" && id !== "erp") {
      setView(VIEWS.LANDING);
    }
    setActiveArea(id === activeArea ? null : id);
  };

  // ===== LANDING VIEW (CRM & ERP + modules) =====
  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-900 via-emerald-700 to-black px-6 py-10 flex flex-col">
      <header className="max-w-6xl mx-auto w-full flex items-center gap-4 pb-6 border-b border-emerald-500/20">
        <div className="flex items-center gap-4">
          <img
            src="/images/logo.png"
            alt="Xforia COAST Logo"
            className="h-14 w-auto object-contain mix-blend-multiply brightness-105 drop-shadow"
          />
          <p className="text-emerald-300 font-semibold text-lg leading-tight">
            Ride the wave of efficiency.
          </p>
        </div>
      </header>

      <main className="flex-1 w-full">
        <div className="max-w-6xl mx-auto text-center text-emerald-200 uppercase tracking-[0.18em] text-[11px] md:text-xs mt-2">
          Unified Intelligence Hub
        </div>

        <div className="max-w-6xl mx-auto text-left mt-4 mb-6">
          <h1 className="text-2xl md:text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-100 via-white to-emerald-200 mt-2 drop-shadow-[0_4px_18px_rgba(16,185,129,0.35)]">
            Unified Analytical Dashboard
          </h1>
          <p className="text-emerald-100/80 mt-3 text-sm md:text-base max-w-3xl">
            A single place to see the full journey of CRM to ERP with dedicated KPI's.
          </p>
          <div className="mt-5 h-px bg-gradient-to-r from-transparent via-emerald-400/50 to-transparent" />
        </div>

        {/* TOP-LEVEL AREA CARDS: Integrated / CRM / ERP */}
        <div className="max-w-6xl mx-auto mt-8 grid gap-6 md:grid-cols-3">
          {/* INTEGRATED CARD */}
          <button
            onClick={() => handleAreaClick("integrated")}
            className={`group text-left bg-[#0b1210]/60 border rounded-2xl p-6 shadow-lg backdrop-blur-sm
                     transition-all duration-200 hover:-translate-y-1
                     ${
                       activeArea === "integrated"
                         ? "border-emerald-300 shadow-emerald-400/40 scale-[1.02]"
                         : "border-emerald-500/30 hover:border-emerald-300 hover:shadow-emerald-400/30"
                     }`}
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white group-hover:text-emerald-100">
                CRM &amp; ERP Integrated KPI Hub
              </h2>
              <span className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-200/30 flex items-center justify-center
                            text-emerald-100 text-sm group-hover:bg-emerald-400 group-hover:text-black transition">
                →
              </span>
            </div>
            <p className="text-emerald-100/70 mt-3 text-sm">
              Unified KPIs across funnel velocity and supply chain (coming next).
            </p>
            <div className="mt-5 flex items-center gap-2 text-xs text-emerald-100/60 group-hover:text-emerald-50">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
              Click to open the integrated view (under construction)
            </div>
          </button>

          {/* CRM CARD */}
          <button
            onClick={() => {
              if (view === VIEWS.CRM_MARKETING && activeArea === "crm") {
                setView(VIEWS.LANDING);
                setActiveArea(null);
              } else {
                setActiveArea("crm");
                setView(VIEWS.CRM_MARKETING);
              }
            }}
            className={`group text-left bg-[#0b1210]/60 border rounded-2xl p-6 shadow-lg backdrop-blur-sm
                     transition-all duration-200 hover:-translate-y-1
                     ${
                       activeArea === "crm"
                         ? "border-emerald-300 shadow-emerald-400/40 scale-[1.02]"
                         : "border-emerald-500/30 hover:border-emerald-300 hover:shadow-emerald-400/30"
                     }`}
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white group-hover:text-emerald-100">
                CRM Analytics
              </h2>
              <span className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-200/30 flex items-center justify-center
                            text-emerald-100 text-sm group-hover:bg-emerald-400 group-hover:text-black transition">
                →
              </span>
            </div>
            <p className="text-emerald-100/70 mt-3 text-sm">
              Clear view across marketing, leads, pipeline, and customers.
            </p>
            <div className="mt-5 flex items-center gap-2 text-xs text-emerald-100/60 group-hover:text-emerald-50">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
              Open the integrated funnel overview
            </div>
          </button>

          {/* ERP CARD */}
          <button
            onClick={() => {
              if (view === VIEWS.ERP && activeArea === "erp") {
                setView(VIEWS.LANDING);
                setActiveArea(null);
              } else {
                setActiveArea("erp");
                setView(VIEWS.ERP);
              }
            }}
            className={`group text-left bg-[#0b1210]/60 border rounded-2xl p-6 shadow-lg backdrop-blur-sm
                     transition-all duration-200 hover:-translate-y-1
                     ${
                       activeArea === "erp"
                         ? "border-emerald-300 shadow-emerald-400/40 scale-[1.02]"
                         : "border-emerald-500/30 hover:border-emerald-300 hover:shadow-emerald-400/30"
                     }`}
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold text-white group-hover:text-emerald-100">
                ERP Analytics
              </h2>
              <span className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-200/30 flex items-center justify-center
                            text-emerald-100 text-sm group-hover:bg-emerald-400 group-hover:text-black transition">
                →
              </span>
            </div>
            <p className="text-emerald-100/70 mt-3 text-sm">
              Procurement, production, and inventory insights.
            </p>
            <div className="mt-5 flex items-center gap-2 text-xs text-emerald-100/60 group-hover:text-emerald-50">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
              Click to reveal ERP modules
            </div>
          </button>
        </div>

        {view === VIEWS.CRM_MARKETING && (
          <MarketingDashboard
            onBack={() => {
              setView(VIEWS.LANDING);
              setActiveArea(null);
            }}
          />
        )}

        {view === VIEWS.ERP && (
          <ERPDashboard
            onBack={() => {
              setView(VIEWS.LANDING);
              setActiveArea(null);
            }}
          />
        )}
      </main>

      <footer className="max-w-6xl mx-auto w-full mt-10 pt-6 border-t border-emerald-500/20 text-emerald-100/80 text-sm text-center">
        © 2025 Xforia COAST - All Rights Reserved.
      </footer>
    </div>
  );
}

export default App;
