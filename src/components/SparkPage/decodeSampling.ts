import type { DecodeBenchConfig } from "../../api/types";

/** "temp 0.7 · thinking on". Runs saved before these options existed ran at temp 0 with thinking off. */
export function decodeBenchSamplingLabel(config: Pick<DecodeBenchConfig, "temperature" | "thinking"> | null | undefined): string {
  const temp = typeof config?.temperature === "number" ? config.temperature : 0;
  const thinking = typeof config?.thinking === "boolean" ? config.thinking : false;
  return `temp ${temp} · thinking ${thinking ? "on" : "off"}`;
}
