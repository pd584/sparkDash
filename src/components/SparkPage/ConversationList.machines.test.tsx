/**
 * Machine-level aggregation: the lane shows tailnet machines being served,
 * never individual sessions. Socket peers and helper session rows merge into
 * one row per machine, named through the fleet tailnet map.
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { render, flush, cleanupRenders } from "../../testing/render";

const tailnetPeers = [
  { ip: "100.68.163.3", name: "igor", dnsName: "igor.tail736217.ts.net", online: true },
  // tailscale registers disco endpoint addrs too — the LAN ip resolves to
  // the same machine, exactly as the real fleet map does for igor.
  { ip: "10.0.10.105", name: "igor", dnsName: "igor.tail736217.ts.net", online: true },
];

vi.mock("../../api/tailnet", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  fetchTailnetPeers: vi.fn(async () => tailnetPeers),
}));
vi.mock("../../api/client", () => ({
  fetchOccupancyHelpers: vi.fn(async () => ({ helpers: [{ id: "igor-hermes", url: "http://10.0.10.105:8124/occupancy" }] })),
}));

import { ConversationList } from "./ConversationList";

async function renderList(props: Parameters<typeof ConversationList>[0]) {
  const view = render(<ConversationList {...props} />);
  await act(async () => {
    await flush();
  });
  return view;
}

describe("ConversationList machine aggregation", () => {
  it("collapses helper sessions + serving socket into one named machine row", async () => {
    const conversations = [
      { id: "igor-hermes:hermes:s1", source: "hermes", handle: "nexus a", badge: "unknown", port: 8888, lastUsedAt: Date.now() - 60_000 },
      { id: "igor-hermes:hermes:s2", source: "hermes", handle: "nexus b", badge: "unknown", port: 8888, lastUsedAt: Date.now() - 30_000 },
    ];
    const peers = [{ ip: "100.68.163.3", name: "igor", connections: 2, serving: true }];
    const view = await renderList({ conversations: conversations as never, peers: peers as never });
    const rows = [...view.container.querySelectorAll(".occupancy-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("igor");
    expect(rows[0].textContent).toContain("serving");
    expect(rows[0].textContent).toContain("2 sessions");
    expect(rows[0].className).toContain("is-generating");
    // Session handles never surface:
    expect(view.container.textContent).not.toContain("nexus a");
    cleanupRenders();
  });

  it("names socket-only peers through the tailnet map", async () => {
    const view = await renderList({ conversations: [], peers: [{ ip: "100.68.163.3", name: "igor", connections: 1, serving: false }] as never });
    const row = view.container.querySelector(".occupancy-row")!;
    expect(row.textContent).toContain("igor");
    expect(row.className).toContain("is-idle");
    cleanupRenders();
  });

  it("falls back to the helper id for sessions from unregistered hosts", async () => {
    const conversations = [{ id: "stray:hermes:s1", source: "hermes", handle: "x", badge: "unknown", port: 8888 }];
    const view = await renderList({ conversations: conversations as never, peers: [] });
    expect(view.container.textContent).toContain("stray");
    cleanupRenders();
  });

  it("marks a machine generating from session badges and stale separately", async () => {
    const conversations = [{ id: "igor-hermes:hermes:s1", source: "hermes", handle: "x", badge: "generating", port: 8888, lastUsedAt: Date.now() }];
    const view = await renderList({ conversations: conversations as never, peers: [] });
    expect(view.container.querySelector(".occupancy-row")!.className).toContain("is-generating");
    expect(view.container.textContent).toContain("Generating");
    cleanupRenders();

    const stale = await renderList({
      conversations: [{ id: "igor-hermes:hermes:s1", source: "hermes", handle: "x", badge: "unknown", port: 8888, stale: true }] as never,
      peers: [],
    });
    expect(stale.container.querySelector(".occupancy-row")!.className).toContain("is-stalled");
    expect(stale.container.textContent).toContain("stale");
    cleanupRenders();
  });
});
