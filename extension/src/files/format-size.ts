const KIB = 1024;
const MIB = 1024 * 1024;

/** A file size for the screen: "472 KB" below 1 MiB (at least 1 KB), otherwise "4,6 MB" (base 1024, decimal comma). */
export function formatSize(bytes: number): string {
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / KIB))} KB`;
  return `${(bytes / MIB).toFixed(1).replace(".", ",")} MB`;
}
