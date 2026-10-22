import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOverlayClose } from "./useOverlayClose";
import { render } from "../testing/render";

function setup(enabled = true) {
  const onClose = vi.fn();
  function Overlay() {
    const overlay = useOverlayClose(onClose, enabled);
    return (
      <div data-testid="overlay" {...overlay}>
        <div data-testid="sheet">
          <input data-testid="field" />
        </div>
      </div>
    );
  }
  const { container } = render(<Overlay />);
  const overlay = container.querySelector<HTMLElement>("[data-testid=overlay]")!;
  const sheet = container.querySelector<HTMLElement>("[data-testid=sheet]")!;
  const press = (el: HTMLElement) => act(() => void el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  // A click fires on the nearest common ancestor of the mousedown and mouseup targets.
  const click = (el: HTMLElement) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return { onClose, overlay, sheet, press, click };
}

describe("useOverlayClose", () => {
  it("closes on a press and release on the overlay", () => {
    const { onClose, overlay, press, click } = setup();
    press(overlay);
    click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when a drag starts inside the dialog and ends on the overlay", () => {
    const { onClose, overlay, sheet, press, click } = setup();
    press(sheet);
    click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on a click inside the dialog", () => {
    const { onClose, sheet, press, click } = setup();
    press(sheet);
    click(sheet);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("forgets the press after a click, so a stray click does not close", () => {
    const { onClose, overlay, press, click } = setup();
    press(overlay);
    click(overlay);
    click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close while disabled", () => {
    const { onClose, overlay, press, click } = setup(false);
    press(overlay);
    click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });
});
