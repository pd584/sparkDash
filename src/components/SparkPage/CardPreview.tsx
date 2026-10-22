/**
 * The "Show card" window: the share image in a panel on a blurred scrim, with
 * the ways to take it with you. Presentational — the caller owns the blob URL,
 * Escape handling and what the buttons do.
 */
import type { ReactNode } from "react";

interface CardPreviewProps {
  /** Blob URL of the rendered PNG. */
  url: string;
  /** Accessible name of the dialog, e.g. "Benchmark share card". */
  label: string;
  imgAlt: string;
  hint: ReactNode;
  onClose: () => void;
  onDownload: () => void;
  /** Present where the page can write an image to the clipboard. */
  onCopy?: () => void;
  copyLabel?: string;
}

export function CardPreview({ url, label, imgAlt, hint, onClose, onDownload, onCopy, copyLabel = "Copy image" }: CardPreviewProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="card-preview"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-preview__panel">
        <div className="card-preview__head">
          <h2>Share card</h2>
          <button type="button" className="icon-circle" onClick={onClose} aria-label="Close share card">
            ✕
          </button>
        </div>
        <img src={url} alt={imgAlt} className="card-preview__img" />
        <p className="card-preview__hint">{hint}</p>
        <div className="card-preview__actions">
          {onCopy ? (
            <button type="button" className="btn" onClick={onCopy}>
              {copyLabel}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onDownload}>
            Download PNG
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
