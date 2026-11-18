/**
 * Machine-level lane occupancy: one row per tailnet machine that drives
 * this LLM port — "igor is being served", not a session listing.
 *
 * Two feeds merge by machine:
 *  - llm[].clients (socket truth): serving = engine busy AND this peer's
 *    sockets moving.
 *  - occupancy sessions (helper rows): counted per helper machine, resolved
 *    to tailnet names through the fleet peer map.
 */
import type { ConversationRow, LlmClient } from "../../api/types";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchTailnetPeers, resolveTailnetHost, safeUrlHost, type TailnetPeer } from "../../api/tailnet";
import { fetchOccupancyHelpers } from "../../api/client";
import { PlusIcon } from "../ui/icons";

interface ConversationListProps {
  conversations: ConversationRow[];
  /** Live LLM client sockets for this port (per-peer serving truth). */
  peers?: LlmClient[] | null;
  onAddHarness?: () => void;
  now?: number;
}

interface MachineEntry {
  key: string;
  name: string;
  dnsName: string | null;
  serving: boolean;
  generating: boolean;
  sessions: number;
  lastUsedAt: number | null;
  stale: boolean;
}

function formatSessionAge(lastUsedAt: number | null, now: number, language: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (lastUsedAt == null || !Number.isFinite(lastUsedAt)) return "—";
  const delta = Math.max(0, now - lastUsedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return t("sessions.age.now");
  if (delta < hour) return t("sessions.age.minutes", { count: Math.floor(delta / minute) });
  if (delta < day) return t("sessions.age.hours", { count: Math.floor(delta / hour) });
  if (delta < 7 * day) return t("sessions.age.days", { count: Math.floor(delta / day) });
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(lastUsedAt);
}

function machineTone(m: MachineEntry, now: number): "generating" | "stalled" | "recent" | "warm" | "idle" {
  if (m.serving || m.generating) return "generating";
  if (m.stale) return "stalled";
  if (m.lastUsedAt == null || !Number.isFinite(m.lastUsedAt)) return "idle";
  const age = now - m.lastUsedAt;
  if (age < 5 * 60_000) return "recent";
  if (age < 60 * 60_000) return "warm";
  return "idle";
}

export function ConversationList({ conversations, peers, onAddHarness, now = Date.now() }: ConversationListProps) {
  const { t, i18n } = useTranslation("spark");
  const [tailnetPeers, setTailnetPeers] = useState<TailnetPeer[]>([]);
  const [helperHosts, setHelperHosts] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void fetchTailnetPeers().then((list) => {
      if (live) setTailnetPeers(list);
    });
    void fetchOccupancyHelpers()
      .then((data: { helpers?: { id: string; url: string }[] }) => {
        const map: Record<string, string> = {};
        for (const h of data?.helpers ?? []) map[h.id] = safeUrlHost(h.url);
        if (live) setHelperHosts(map);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const machines = useMemo(() => {
    const byKey = new Map<string, MachineEntry>();
    const touch = (host: string | undefined | null, fallbackName: string): MachineEntry => {
      const peer = resolveTailnetHost(host, tailnetPeers);
      const name = peer?.name ?? fallbackName ?? String(host ?? "");
      const key = name.toLowerCase();
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          key,
          name,
          dnsName: peer?.dnsName ?? null,
          serving: false,
          generating: false,
          sessions: 0,
          lastUsedAt: null,
          stale: false,
        };
        byKey.set(key, entry);
      }
      return entry;
    };
    for (const c of Array.isArray(peers) ? peers : []) {
      if (c.ip === "127.0.0.1" || c.ip === "::1") continue;
      const entry = touch(c.ip, c.name || c.ip);
      if (c.serving) entry.serving = true;
    }
    for (const row of conversations) {
      const helperId = typeof row.id === "string" ? row.id.split(":")[0] : "";
      const entry = touch(helperHosts[helperId], helperId || row.source);
      if (row.originHost) {
        // A native-origin session names the machine even without a helper.
        const peer = resolveTailnetHost(row.originHost, tailnetPeers);
        if (peer) {
          entry.name = peer.name;
          entry.key = peer.name.toLowerCase();
          entry.dnsName = peer.dnsName;
        }
      }
      entry.sessions += 1;
      const ts = typeof row.lastUsedAt === "number" && Number.isFinite(row.lastUsedAt) ? row.lastUsedAt : null;
      if (ts != null && (entry.lastUsedAt == null || ts > entry.lastUsedAt)) entry.lastUsedAt = ts;
      if (row.badge === "generating") entry.generating = true;
      if (row.stale) entry.stale = true;
    }
    return [...byKey.values()].sort(
      (a, b) =>
        Number(b.serving) - Number(a.serving) ||
        Number(b.generating) - Number(a.generating) ||
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
    );
  }, [conversations, peers, tailnetPeers, helperHosts, now]);

  const language = i18n.resolvedLanguage ?? i18n.language;

  return (
    <div className="occupancy">
      <div className="occupancy-head">
        <span className="occupancy-head-count">{machines.length}</span>
        <span className="occupancy-head-title">{t("sessions.machinesTitle")}</span>
        {onAddHarness && (
          <button type="button" title={t("sessions.addHarness")} aria-label={t("sessions.addHarness")} onClick={onAddHarness} className="occupancy-head-add">
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {machines.length === 0 ? (
        <div className="occupancy-empty">
          <p>{t("sessions.empty")}</p>
          {onAddHarness && (
            <button type="button" onClick={onAddHarness} className="occupancy-add-harness">
              {t("sessions.addHarnessButton")}
            </button>
          )}
        </div>
      ) : (
        <ul className="occupancy-list occupancy-machines" aria-label={t("sessions.listAriaLabel")}>
          {machines.map((m) => {
            const tone = machineTone(m, now);
            const state = m.serving
              ? t("sessions.serving")
              : m.generating
                ? t("sessions.generating")
                : formatSessionAge(m.lastUsedAt, now, language, t);
            const title = [m.dnsName, m.sessions > 0 ? t("sessions.machineSessions", { count: m.sessions }) : null]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={m.key} className={`occupancy-row is-${tone}`} title={m.stale ? t("sessions.staleTitle") : title}>
                <span className="occupancy-dot" aria-hidden="true" />
                <span className="occupancy-handle">{m.name}</span>
                {m.sessions > 0 ? (
                  <span className="occupancy-ctx">{t("sessions.machineSessions", { count: m.sessions })}</span>
                ) : null}
                <span className="occupancy-state">
                  {state}
                  {m.stale ? <span className="occupancy-stale"> {t("sessions.stale")}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
