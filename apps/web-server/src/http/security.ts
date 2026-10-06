export const CSRF_HEADER = "x-blh-web";

export function isLocalHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
