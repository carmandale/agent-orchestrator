"use client";

import { useState } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { SessionCard } from "./SessionCard";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const zoneConfig: Record<
  AttentionLevel,
  {
    label: string;
    color: string;
    defaultCollapsed: boolean;
  }
> = {
  merge: {
    label: "Needs Merge",
    color: "var(--color-status-ready)",
    defaultCollapsed: false,
  },
  respond: {
    label: "Needs Response",
    color: "var(--color-status-error)",
    defaultCollapsed: false,
  },
  review: {
    label: "Review",
    color: "var(--color-accent-orange)",
    defaultCollapsed: false,
  },
  pending: {
    label: "Pending",
    color: "var(--color-status-attention)",
    defaultCollapsed: false,
  },
  working: {
    label: "Working",
    color: "var(--color-status-working)",
    defaultCollapsed: false,
  },
  done: {
    label: "Done",
    color: "var(--color-text-tertiary)",
    defaultCollapsed: true,
  },
};

export function AttentionZone({
  level,
  sessions,
  onSend,
  onKill,
  onMerge,
  onRestore,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed);

  if (sessions.length === 0) return null;

  return (
    <div className="mb-7">
      {/* Zone header: [●] LABEL ─────────── [count] [▾] */}
      <button
        className="mb-3 flex w-full items-center gap-2 px-1 text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        {/* Status dot */}
        <div
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: config.color }}
        />
        {/* Label */}
        <span
          className="text-[10px] font-bold uppercase tracking-[0.10em]"
          style={{ color: config.color }}
        >
          {config.label}
        </span>
        {/* Divider */}
        <div className="h-px flex-1 bg-[var(--color-border-subtle)]" />
        {/* Count pill */}
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{
            color: config.color,
            background: `color-mix(in srgb, ${config.color} 10%, transparent)`,
          }}
        >
          {sessions.length}
        </span>
        {/* Collapse chevron */}
        <svg
          className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onSend={onSend}
              onKill={onKill}
              onMerge={onMerge}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
    </div>
  );
}
