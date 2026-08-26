import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Search, Sparkles, ChevronRight, LogOut, Settings, User } from "lucide-react";
import type { ViewId } from "../../types";

interface NavbarProps {
  onNavigate?: (view: ViewId) => void;
}

interface AuditEntry {
  seq: number;
  timestamp: string;
  eventType: string;
}

interface CaseHit {
  id: string;
  customerName?: string;
  customerEmail?: string;
  amount: number;
  state: string;
}

export function Navbar({ onNavigate }: NavbarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: notifData } = useQuery({
    queryKey: ["navbar-notifications"],
    queryFn: async () => {
      const [aRes, hRes] = await Promise.all([
        fetch("/api/audit/entries?limit=8"),
        fetch("/api/orchestrator/stats"),
      ]);
      return {
        entries: aRes.ok ? ((await aRes.json()).entries || []) as AuditEntry[] : [],
        escalations: hRes.ok ? ((await hRes.json()).totalEscalated ?? 0) as number : 0,
      };
    },
    refetchInterval: 20000,
  });

  const entries = notifData?.entries ?? [];
  const escalations = notifData?.escalations ?? 0;

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
        setProfileOpen(false);
        setSearchFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: queryHits } = useQuery({
    queryKey: ["case-search", debouncedQuery],
    queryFn: async () => {
      if (debouncedQuery.trim().length < 2) return [];
      const res = await fetch("/api/orchestrator/cases?limit=200");
      if (!res.ok) return [];
      const data = await res.json();
      const q = debouncedQuery.toLowerCase();
      return ((data.cases || []) as CaseHit[])
        .filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            (c.customerName || "").toLowerCase().includes(q) ||
            (c.customerEmail || "").toLowerCase().includes(q)
        )
        .slice(0, 6);
    },
    enabled: debouncedQuery.trim().length >= 2,
  });

  const hits = queryHits ?? [];


  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur-md border-b border-slate-200 shadow-xs">
      <div className="flex items-center justify-between px-8 py-4" ref={wrapRef}>
        {/* Live search over recovery cases */}
        <div className="relative w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            placeholder="Search cases by ID, customer…"
            className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2 text-sm font-body text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 transition-all"
          />
          {searchFocused && query.trim().length >= 2 && (
            <div className="absolute left-0 right-0 top-full mt-2 rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden z-30">
              {hits.length === 0 ? (
                <p className="px-4 py-3 text-xs font-body text-slate-400">No matching cases.</p>
              ) : (
                hits.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      onNavigate?.("cases");
                      setSearchFocused(false);
                    }}
                    className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 text-left cursor-pointer"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold font-body text-slate-800 truncate">{c.customerName || c.customerEmail || c.id}</p>
                      <p className="text-[10px] font-mono text-slate-400">{c.id} · {c.state}</p>
                    </div>
                    <span className="text-xs font-bold text-slate-700 ml-2">₹{Math.round(c.amount).toLocaleString("en-IN")}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-4">
          {/* Live badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 border border-orange-200">
            <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
            <span className="text-xs font-body font-semibold text-brand-orange">
              Live Gateway Connected
            </span>
          </div>

          {/* Notifications */}
          <div className="relative">
            <button
              onClick={() => {
                setNotifOpen((o) => !o);
                setProfileOpen(false);
              }}
              className="relative p-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-600 transition-colors cursor-pointer"
              title="Notifications"
            >
              <Bell className="w-4 h-4" />
              {escalations > 0 && (
                <span className="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full bg-brand-pink text-[9px] font-bold text-white flex items-center justify-center shadow-xs">
                  {escalations}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-full mt-2 w-80 rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden z-30">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                  <p className="text-xs font-bold font-heading text-slate-800">Notifications</p>
                  {escalations > 0 && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
                      {escalations} escalations need review
                    </span>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {entries.length === 0 ? (
                    <p className="px-4 py-6 text-xs font-body text-slate-400 text-center">
                      Backend offline or no pipeline activity yet.
                    </p>
                  ) : (
                    entries.map((e) => (
                      <div key={e.seq} className="px-4 py-2.5 border-b border-slate-50 last:border-0 flex items-center gap-3">
                        <span className="text-[10px] font-mono text-slate-300">#{e.seq}</span>
                        <span className="text-xs font-body font-medium text-slate-700">{e.eventType}</span>
                        <span className="ml-auto text-[10px] text-slate-400 font-body">
                          {new Date(e.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <button
                  onClick={() => {
                    onNavigate?.("audit");
                    setNotifOpen(false);
                  }}
                  className="w-full px-4 py-2.5 text-xs font-bold font-body text-brand-orange hover:bg-orange-50 flex items-center justify-center gap-1 cursor-pointer border-t border-slate-100"
                >
                  Open Audit Ledger <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Profile */}
          <div className="relative">
            <button
              onClick={() => {
                setProfileOpen((o) => !o);
                setNotifOpen(false);
              }}
              className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-orange to-brand-pink flex items-center justify-center text-xs font-heading font-bold text-white shadow-xs cursor-pointer hover:opacity-90 transition-opacity"
              title="Merchant account"
            >
              HK
            </button>
            {profileOpen && (
              <div className="absolute right-0 top-full mt-2 w-60 rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden z-30">
                <div className="px-4 py-3 border-b border-slate-100">
                  <p className="text-sm font-bold font-heading text-slate-900">Harsh Kumar</p>
                  <p className="text-[11px] font-body text-slate-400">Merchant Admin · TechCorp (Demo)</p>
                </div>
                <button
                  onClick={() => {
                    onNavigate?.("playbooks");
                    setProfileOpen(false);
                  }}
                  className="w-full px-4 py-2.5 text-xs font-body font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-2.5 cursor-pointer"
                >
                  <Settings className="w-3.5 h-3.5 text-slate-400" /> Playbook Settings
                </button>
                <button
                  onClick={() => {
                    onNavigate?.("overview");
                    setProfileOpen(false);
                  }}
                  className="w-full px-4 py-2.5 text-xs font-body font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-2.5 cursor-pointer"
                >
                  <User className="w-3.5 h-3.5 text-slate-400" /> Account Overview
                </button>
                <button
                  disabled
                  title="Authentication not wired in this demo build"
                  className="w-full px-4 py-2.5 text-xs font-body font-medium text-slate-400 flex items-center gap-2.5 cursor-not-allowed opacity-60 border-t border-slate-100"
                >
                  <LogOut className="w-3.5 h-3.5" /> Sign Out (demo)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

