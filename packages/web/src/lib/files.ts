import type { AttachmentUpload } from "@soloagent/client";

/** Server limits (see ATTACHMENT_LIMITS in @soloagent/core). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;

/** Image types the dashboard can preview and the server serves inline. */
export const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 104.8576)) / 10} MB`;
}

export function fileUrl(sha256: string): string {
  return `/api/files/${encodeURIComponent(sha256)}`;
}

/** Read files as base64 for `POST /api/threads/:id/messages`. */
export async function toUploads(files: File[]): Promise<AttachmentUpload[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<AttachmentUpload>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: file.name || "pasted-image.png", mimeType: file.type, data_base64: String(reader.result).replace(/^data:[^,]*,/, "") });
          reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
          reader.readAsDataURL(file);
        }),
    ),
  );
}
