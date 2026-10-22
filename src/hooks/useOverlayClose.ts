import { useRef, type MouseEvent } from "react";

/**
 * Click-outside-to-close for a modal overlay. The press has to start on the
 * overlay as well: a text selection that begins inside the dialog and is
 * released on the overlay fires `click` on the overlay (the common ancestor)
 * and must not close it. Spread the result onto the overlay element.
 */
export function useOverlayClose(onClose: () => void, enabled = true) {
  const downOnOverlay = useRef(false);
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      downOnOverlay.current = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const startedOnOverlay = downOnOverlay.current;
      downOnOverlay.current = false;
      if (enabled && startedOnOverlay && e.target === e.currentTarget) onClose();
    },
  };
}
