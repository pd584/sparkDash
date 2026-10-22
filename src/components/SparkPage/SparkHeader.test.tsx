import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { OVERVIEW_ID } from "../../constants";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { SparkHeader } from "./SparkHeader";

describe("SparkHeader back link", () => {
  it("goes back to the overview when onNavigate is passed", () => {
    const onNavigate = vi.fn();
    const { container } = render(<SparkHeader spark={makeSpark()} onNavigate={onNavigate} />);
    const back = container.querySelector<HTMLButtonElement>("button.sp-back");
    expect(back).not.toBeNull();
    act(() => back!.click());
    expect(onNavigate).toHaveBeenCalledWith(OVERVIEW_ID);
  });

  it("renders no link without onNavigate", () => {
    const { container } = render(<SparkHeader spark={makeSpark()} />);
    expect(container.querySelector("button.sp-back")).toBeNull();
  });
});
