/**
 * Sessions must name the tailnet machine behind a native-origin row —
 * resolved through the live LLM clients peers map, falling back to the
 * raw host when unresolvable, silent when there is no origin.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { ConversationList } from "./ConversationList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.host ? `${key}:${opts.host}` : key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

const row = {
  id: "ltd-1:hermes:s1",
  source: "hermes",
  handle: "nexus-eval",
  badge: "unknown",
  port: 8888,
  originHost: "igor.tail736217.ts.net",
};

const peers = [
  {
    ip: "100.68.163.3",
    name: "igor",
    dnsName: "igor.tail736217.ts.net",
    connections: 2,
    online: true,
    recvQ: 0,
    sendQ: 0,
    lastSndMs: 100,
    lastRcvMs: 100,
    bytesPerSec: 500,
    serving: true,
  },
];

describe("ConversationList tailnet origin", () => {
  it("renders the resolved peer name for a native-origin row", () => {
    const { container } = render(<ConversationList conversations={[row] as never} peers={peers as never} />);
    const chip = container.querySelector(".occupancy-origin");
    expect(chip?.textContent).toBe("igor");
  });

  it("falls back to the raw host when the peers map misses", () => {
    const { container } = render(<ConversationList conversations={[row] as never} peers={[]} />);
    expect(container.querySelector(".occupancy-origin")?.textContent).toBe("igor.tail736217.ts.net");
  });

  it("renders no origin chip without originHost", () => {
    const { container } = render(
      <ConversationList conversations={[{ ...row, originHost: undefined }] as never} peers={peers as never} />
    );
    expect(container.querySelector(".occupancy-origin")).toBeNull();
  });
});
