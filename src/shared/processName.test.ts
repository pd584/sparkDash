import { describe, expect, it } from "vitest";
import { shortProcessName } from "./processName";

describe("shortProcessName", () => {
  it("keeps only the program of a full command line", () => {
    expect(
      shortProcessName(
        "/opt/brave.com/brave/brave --type=gpu-process --gpu-recent-crash-count=0 --ozone-platform=wayland --render-node-override=/dev/dri/renderD129"
      )
    ).toBe("brave");
    expect(shortProcessName("python3 -m vllm.entrypoints.openai.api_server")).toBe("python3");
  });

  it("drops the directory of a plain executable path", () => {
    expect(shortProcessName("/home/aibox/llm/llama.cpp/build/bin/llama-server")).toBe("llama-server");
    expect(shortProcessName("/usr/bin/ptyxis")).toBe("ptyxis");
    expect(shortProcessName("flare")).toBe("flare");
  });

  it("keeps spaces inside a Windows executable path", () => {
    expect(shortProcessName("C:\\Program Files\\BraveSoftware\\brave.exe")).toBe("brave.exe");
    expect(shortProcessName('"C:\\Program Files\\App\\app.exe" --flag')).toBe("app.exe");
  });

  it("returns placeholders unchanged", () => {
    expect(shortProcessName("[Not Found]")).toBe("[Not Found]");
    expect(shortProcessName("")).toBe("");
  });
});
