import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, X } from "lucide-react";

/** A full-window look at one image. Esc, the close button, or a click outside the image closes it. */
export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const button = "grid size-9 place-items-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={name} onClick={onClose} className="fixed inset-0 z-[90] flex animate-fade-in flex-col bg-black/85 backdrop-blur-sm">
      <div className="flex shrink-0 items-center gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        <a href={src} download={name} aria-label="Download" title="Download" className={button}>
          <Download className="size-4" />
        </a>
        <a href={src} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className={button}>
          <ExternalLink className="size-4" />
        </a>
        <button type="button" autoFocus onClick={onClose} aria-label="Close" title="Close (Esc)" className={button}>
          <X className="size-4.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">
        <img src={src} alt={name} onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
      </div>
    </div>,
    document.body,
  );
}
