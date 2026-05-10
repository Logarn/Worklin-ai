"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  GraduationCap,
  LayoutGrid,
  Megaphone,
  Sparkles,
  Users2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/agent", label: "Agent", icon: Sparkles },
  { href: "/agent/workflows", label: "Workflow Canvas", icon: ClipboardList },
  { href: "/brain", label: "Brand Brain", icon: Brain },
];

const legacyNavItems: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/planner", label: "Planner", icon: ClipboardList },
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/customers", label: "Customers", icon: Users2 },
  { href: "/segments", label: "RFM Segments", icon: BarChart3 },
  { href: "/campaigns", label: "Campaign CRUD", icon: Megaphone },
  { href: "/composer", label: "AI Composer", icon: Bot },
  { href: "/templates", label: "Templates", icon: LayoutGrid },
  { href: "/audits/retention", label: "Audit Canvas", icon: ClipboardList },
];

const brainItems: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/brain/learned", label: "What I learned", icon: GraduationCap },
  { href: "/brain", label: "Overview", icon: Brain },
  { href: "/brain/profile", label: "Brand Profile", icon: Brain },
  { href: "/brain/analyzer", label: "Store Analyzer", icon: Brain },
  { href: "/brain/documents", label: "Documents", icon: Brain },
  { href: "/brain/test", label: "Voice Test", icon: Brain },
  { href: "/brain/competitors", label: "Competitors", icon: Brain },
];

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const fullBleed = pathname === "/agent";
  const legacyPathActive = legacyNavItems.some(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  const [brainExpanded, setBrainExpanded] = useState(pathname.startsWith("/brain"));
  const [legacyExpanded, setLegacyExpanded] = useState(legacyPathActive);

  useEffect(() => {
    if (pathname.startsWith("/brain")) {
      setBrainExpanded(true);
    }
  }, [pathname]);

  useEffect(() => {
    if (legacyPathActive) {
      setLegacyExpanded(true);
    }
  }, [legacyPathActive]);

  function isActivePath(href: string) {
    return pathname === href || (href !== "/agent" && pathname.startsWith(`${href}/`));
  }

  return (
    <div className="min-h-screen">
      <div
        className={`mx-auto grid max-w-[1440px] grid-cols-1 md:grid-cols-[250px_1fr] ${
          fullBleed ? "gap-0 p-0 md:p-0" : "gap-6 p-4 md:p-6"
        }`}
      >
        <aside
          className={`h-fit rounded-2xl border border-white/10 bg-gradient-to-b from-[#121a28]/95 to-[#0d131f]/95 shadow-[0_20px_70px_rgba(2,6,23,0.55)] backdrop-blur-xl md:sticky md:top-6 ${
            fullBleed ? "m-4 p-4 md:m-6" : "p-4"
          }`}
        >
          <div className="mb-6 space-y-1 border-b border-white/10 pb-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">Worklin</p>
            <h1 className="text-lg font-semibold text-slate-100">Agent OS</h1>
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const active = isActivePath(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-[linear-gradient(135deg,rgba(255,123,66,0.22),rgba(245,158,11,0.2))] text-orange-100 ring-1 ring-orange-300/30"
                      : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
                  )}
                >
                  <Icon size={16} className={active ? "text-orange-300" : "text-slate-400"} />
                  {item.label}
                </Link>
              );
            })}

            <div className="pt-1">
              <button
                type="button"
                onClick={() => setBrainExpanded((previous) => !previous)}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors",
                  pathname.startsWith("/brain")
                    ? "bg-[linear-gradient(135deg,rgba(255,123,66,0.22),rgba(245,158,11,0.2))] text-orange-100 ring-1 ring-orange-300/30"
                    : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
                )}
                aria-expanded={brainExpanded}
                aria-controls="brain-subnav"
              >
                <span className="flex items-center gap-2.5">
                  <Brain
                    size={16}
                    className={pathname.startsWith("/brain") ? "text-orange-300" : "text-slate-400"}
                  />
                  My Brain
                </span>
                {brainExpanded ? (
                  <ChevronDown size={16} className="text-slate-400" />
                ) : (
                  <ChevronRight size={16} className="text-slate-400" />
                )}
              </button>

              {brainExpanded ? (
                <div id="brain-subnav" className="mt-1 space-y-1 border-l border-white/10 pl-3">
                  {brainItems.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    const SubIcon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                          active
                            ? "bg-white/10 text-orange-100"
                            : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
                        )}
                      >
                        <SubIcon size={14} className={active ? "text-orange-300/90" : "text-slate-500"} />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="pt-1">
              <button
                type="button"
                onClick={() => setLegacyExpanded((previous) => !previous)}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors",
                  legacyPathActive
                    ? "bg-amber-400/10 text-amber-100 ring-1 ring-amber-300/20"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-100",
                )}
                aria-expanded={legacyExpanded}
                aria-controls="legacy-subnav"
              >
                <span className="flex items-center gap-2.5">
                  <LayoutGrid size={16} className={legacyPathActive ? "text-amber-300/90" : "text-slate-500"} />
                  Legacy/internal
                </span>
                {legacyExpanded ? (
                  <ChevronDown size={16} className="text-slate-500" />
                ) : (
                  <ChevronRight size={16} className="text-slate-500" />
                )}
              </button>

              {legacyExpanded ? (
                <div id="legacy-subnav" className="mt-1 space-y-1 border-l border-white/10 pl-3">
                  {legacyNavItems.map((item) => {
                    const active = isActivePath(item.href);
                    const LegacyIcon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                          active
                            ? "bg-amber-400/10 text-amber-100"
                            : "text-slate-400 hover:bg-white/5 hover:text-slate-100",
                        )}
                      >
                        <LegacyIcon size={14} className={active ? "text-amber-300/90" : "text-slate-500"} />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </nav>
          <div className="mt-6 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
            <p className="text-xs text-slate-400">Primary path</p>
            <p className="mt-1 text-sm font-medium text-slate-200">Ask the agent. Review canvases. Approve drafts.</p>
          </div>
        </aside>
        <main
          className={
            fullBleed
              ? "flex min-h-[calc(100vh-0px)] flex-col overflow-hidden pb-0 md:min-h-screen"
              : "space-y-6 pb-8"
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
