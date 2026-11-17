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
  const button = "grid size-9 place-items-center rounded-lg text-white/75 transition-colors hover:bg-white/10 hover:text-white";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={name} onClick={onClose} className="fixed inset-0 z-[90] flex animate-fade-in flex-col bg-black/85 backdrop-blur-md">
      <div className="flex shrink-0 items-center gap-1 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-white/80">{name}</span>
        <a href={src} download={name} aria-label="Download" title="Download" className={button}>
          <Download className="size-4" />
        </a>
        <a href={src} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className={button}>
          <ExternalLink className="size-4" />
        </a>
        <span className="mx-1 h-5 w-px bg-white/15" />
        <button type="button" autoFocus onClick={onClose} aria-label="Close" title="Close (Esc)" className={button}>
          <X className="size-[18px]" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0 sm:p-8 sm:pt-0">
        <img
          src={src}
          alt={name}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full animate-scale-in rounded-xl object-contain shadow-[0_30px_100px_-20px_rgb(0_0_0/0.9)] ring-1 ring-white/10"
        />
      </div>
    </div>,
    document.body,
  );
}
