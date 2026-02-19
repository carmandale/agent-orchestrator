"use client";

import { useState, useEffect, useRef } from "react";
import {
  type DashboardSession,
  type AttentionLevel,
  getAttentionLevel,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { activityIcon } from "@/lib/activity-icons";
import { getSessionTitle } from "@/lib/format";
import { PRStatus } from "./PRStatus";
import { CICheckList } from "./CIBadge";

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

/** 8×8px CSS dot representing activity state */
function ActivityDot({ activity }: { activity: string | null }) {
  const colorMap: Record<string, string> = {
    active: "var(--color-status-working)",
    ready: "var(--color-status-ready)",
    idle: "var(--color-status-idle)",
    waiting_input: "var(--color-status-attention)",
    blocked: "var(--color-status-error)",
    exited: "var(--color-status-done)",
  };

  const color = (activity && colorMap[activity]) ?? "var(--color-text-tertiary)";
  const isPulsing = activity === "active";

  return (
    <div
      className={cn("h-2 w-2 shrink-0 rounded-full", isPulsing && "animate-[activity-pulse_2s_ease-in-out_infinite]")}
      style={{ background: color }}
    />
  );
}


const borderColorByLevel: Record<AttentionLevel, string> = {
  merge: "border-l-[var(--color-status-ready)]",
  respond: "border-l-[var(--color-status-error)]",
  review: "border-l-[var(--color-accent-orange)]",
  pending: "border-l-[var(--color-status-attention)]",
  working: "border-l-[var(--color-status-working)]",
  done: "border-l-[var(--color-border-default)]",
};

export function SessionCard({ session, onSend, onKill, onMerge, onRestore }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [sendingAction, setSendingAction] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const level = getAttentionLevel(session);
  const pr = session.pr;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleAction = async (action: string, message: string) => {
    setSendingAction(action);
    onSend?.(session.id, message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSendingAction(null), 2000);
  };

  const alerts = getAlerts(session);
  const isReadyToMerge = pr?.mergeability.mergeable && pr.state === "open";
  const isTerminal =
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity));
  const isRestorable = isTerminal && session.status !== "merged";

  return (
    <div
      className={cn(
        "cursor-pointer border border-[var(--color-border-default)] border-l-[3px] bg-[var(--color-bg-surface)] transition-colors duration-[250ms] hover:border-[var(--color-border-strong)]",
        borderColorByLevel[level],
        expanded && "border-[var(--color-border-strong)]",
        isReadyToMerge && "border-[rgba(34,197,94,0.35)] bg-[rgba(34,197,94,0.02)]",
        pr?.state === "merged" && "opacity-60",
      )}
      style={{ borderRadius: 6 }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, textarea")) return;
        setExpanded(!expanded);
      }}
    >
      {/* Top row */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
        <ActivityDot activity={session.activity} />
        <span className="shrink-0 font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
          {session.id}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-primary)]">
          {getSessionTitle(session)}
        </span>
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="shrink-0 rounded border border-[rgba(91,126,248,0.35)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[rgba(91,126,248,0.1)]"
          >
            restore
          </button>
        )}
        {!isTerminal && (
          <a
            href={`/sessions/${encodeURIComponent(session.id)}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:no-underline"
          >
            terminal
          </a>
        )}
      </div>

      {/* Meta row: branch + PR pills */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pl-[26px]">
        {session.branch && (
          <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
            {session.branch}
          </span>
        )}
        {session.branch && pr && (
          <span className="text-[9px] text-[var(--color-border-default)]">&middot;</span>
        )}
        {pr && <PRStatus pr={pr} />}
      </div>

      {/* Merge button or alert tags */}
      {(alerts.length > 0 || isReadyToMerge) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pl-[26px]">
          {isReadyToMerge && pr ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMerge?.(pr.number);
              }}
              className="inline-flex items-center gap-1.5 rounded border-0 bg-[var(--color-status-ready)] px-3 py-1 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-[filter,transform] duration-[100ms] hover:-translate-y-px hover:brightness-110"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Merge PR #{pr.number}
            </button>
          ) : (
            alerts.map((alert) => (
              <span key={alert.key}>
                <a
                  href={alert.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded border px-2.5 py-0.5 text-[11px] font-semibold hover:brightness-125 hover:no-underline",
                    alert.className,
                  )}
                >
                  {alert.count !== undefined && (
                    <span className="font-bold">{alert.count}</span>
                  )}
                  {alert.label}
                </a>
                {alert.actionLabel && session.activity !== "active" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAction(alert.key, alert.actionMessage ?? "");
                    }}
                    disabled={sendingAction === alert.key}
                    className="ml-1 rounded border border-[rgba(91,126,248,0.3)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[rgba(91,126,248,0.1)] disabled:opacity-50"
                  >
                    {sendingAction === alert.key ? "sent!" : alert.actionLabel}
                  </button>
                )}
              </span>
            ))
          )}
        </div>
      )}

      {/* Expandable detail panel */}
      {expanded && (
        <div className="border-t border-[var(--color-border-subtle)] px-3 py-3 pl-[26px]">
          {session.summary && pr?.title && session.summary !== pr.title && (
            <DetailSection label="Summary">
              <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                {session.summary}
              </p>
            </DetailSection>
          )}

          {session.issueUrl && (
            <DetailSection label="Issue">
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-[var(--color-accent)] hover:underline"
              >
                {session.issueLabel || session.issueUrl}
                {session.issueTitle && `: ${session.issueTitle}`}
              </a>
            </DetailSection>
          )}

          {pr && pr.ciChecks.length > 0 && (
            <DetailSection label="CI Checks">
              <CICheckList checks={pr.ciChecks} />
            </DetailSection>
          )}

          {pr && pr.unresolvedComments.length > 0 && (
            <DetailSection label="Unresolved Comments">
              <div className="space-y-1">
                {pr.unresolvedComments.map((c) => (
                  <div key={c.url} className="flex items-center gap-2 text-[12px]">
                    <span className="w-3 shrink-0 text-center text-[var(--color-status-error)]">
                      {"\u25CF"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)]">
                      {c.path}
                    </span>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-[11px] text-[var(--color-accent)] hover:underline"
                    >
                      view →
                    </a>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {pr && (
            <DetailSection label="PR">
              <p className="text-[12px] text-[var(--color-text-secondary)]">
                <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {pr.title}
                </a>
                <br />
                <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
                <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
                {" · "}mergeable: {pr.mergeability.mergeable ? "yes" : "no"}
                {" · "}review: {pr.reviewDecision}
              </p>
            </DetailSection>
          )}

          {!pr && (
            <p className="text-[12px] text-[var(--color-text-tertiary)]">
              No PR associated with this session.
            </p>
          )}

          <div className="mt-3 flex gap-2 border-t border-[var(--color-border-subtle)] pt-3">
            {isRestorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore?.(session.id);
                }}
                className="rounded border border-[rgba(91,126,248,0.35)] px-2.5 py-1 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[rgba(91,126,248,0.1)]"
              >
                restore session
              </button>
            )}
            {!isTerminal && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onKill?.(session.id);
                }}
                className="rounded border border-[rgba(239,68,68,0.35)] px-2.5 py-1 text-[11px] text-[var(--color-status-error)] transition-colors hover:bg-[rgba(239,68,68,0.1)]"
              >
                terminate
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      {children}
    </div>
  );
}

interface Alert {
  key: string;
  label: string;
  className: string;
  url: string;
  count?: number;
  actionLabel?: string;
  actionMessage?: string;
}

function getAlerts(session: DashboardSession): Alert[] {
  const pr = session.pr;
  if (!pr || pr.state !== "open") return [];

  const alerts: Alert[] = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failedCheck = pr.ciChecks.find((c) => c.status === "failed");
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;

    if (failCount === 0) {
      alerts.push({
        key: "ci-unknown",
        label: "CI unknown",
        className:
          "border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-[var(--color-status-attention)]",
        url: pr.url + "/checks",
      });
    } else {
      alerts.push({
        key: "ci-fail",
        label: `${failCount} CI check${failCount > 1 ? "s" : ""} failing`,
        className:
          "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
        url: failedCheck?.url ?? pr.url + "/checks",
        actionLabel: "ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
      });
    }
  }

  if (pr.reviewDecision === "changes_requested") {
    alerts.push({
      key: "changes",
      label: "changes requested",
      className:
        "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
      url: pr.url,
    });
  } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      label: "needs review",
      className:
        "border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-[var(--color-status-attention)]",
      url: pr.url,
      actionLabel: "ask to post",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
    });
  }

  if (!pr.mergeability.noConflicts) {
    alerts.push({
      key: "conflict",
      label: "merge conflict",
      className:
        "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
      url: pr.url,
      actionLabel: "ask to fix",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
    });
  }

  if (pr.unresolvedThreads > 0) {
    const firstUrl = pr.unresolvedComments[0]?.url ?? pr.url + "/files";
    alerts.push({
      key: "comments",
      label: "unresolved comments",
      count: pr.unresolvedThreads,
      className:
        "border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] text-[var(--color-status-error)]",
      url: firstUrl,
      actionLabel: "ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
    });
  }

  return alerts;
}
