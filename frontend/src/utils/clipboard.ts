/**
 * Robust clipboard copy utility.
 *
 * Supports modern Clipboard API in secure contexts (HTTPS/localhost)
 * and falls back to a temporary textarea with document.execCommand('copy')
 * for insecure contexts (HTTP LAN/IP addresses) or when Clipboard API fails.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. Try modern async Clipboard API if available
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below if permission was denied or clipboard API threw
    }
  }

  // 2. Fallback to execCommand('copy') via temporary textarea
  if (typeof document !== "undefined") {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      // Ensure the textarea is off-screen and does not cause visual jump or scrolling
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      textArea.style.top = "-9999px";
      textArea.style.opacity = "0";
      textArea.setAttribute("readonly", "");
      document.body.appendChild(textArea);

      textArea.focus();
      textArea.select();
      textArea.setSelectionRange(0, textArea.value.length);

      const successful = document.execCommand("copy");
      document.body.removeChild(textArea);
      return successful;
    } catch (err) {
      console.warn("execCommand copy fallback failed:", err);
    }
  }

  return false;
}
