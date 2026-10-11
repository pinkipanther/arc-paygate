/**
 * Listing metadata lives in the resource `uri` (max 512 bytes on-chain). Two forms are accepted:
 *   1. a compact JSON object: {"name":"…","desc":"…","url":"https://…","kind":"dataset"}
 *   2. a plain URL, from which a name is derived ("…/api/polymarket-rewards" → "Polymarket rewards")
 */
export interface Meta {
  name: string;
  desc: string;
  url: string | null;
  kind: string | null;
  host: string | null;
  path: string | null;
}

function titleize(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]+$/i, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

function urlParts(u: string | null): { host: string | null; path: string | null } {
  if (!u) return { host: null, path: null };
  try {
    const x = new URL(u);
    return { host: x.host, path: x.pathname + x.search };
  } catch {
    return { host: null, path: null };
  }
}

export function parseMeta(uri: string, id: bigint | number): Meta {
  const fallback = `Resource #${id}`;
  const raw = (uri || "").trim();
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string).trim() : "");
      const rawUrl = str("url") || str("u");
      // Listings are untrusted: only http(s) endpoints are ever fetched or shown as endpoints.
      const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
      return {
        name: str("name") || str("n") || fallback,
        desc: str("desc") || str("description") || str("d"),
        url,
        kind: str("kind") || str("k") || null,
        ...urlParts(url),
      };
    } catch {
      /* fall through to plain handling */
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    const { host, path } = urlParts(raw);
    const seg = (path || "").split("?")[0].split("/").filter(Boolean).pop() || host || "";
    return { name: titleize(seg) || fallback, desc: "", url: raw, kind: null, host, path };
  }
  return { name: raw ? raw.slice(0, 80) : fallback, desc: "", url: null, kind: null, host: null, path: null };
}

export function buildMeta(m: { name: string; desc: string; url: string; kind?: string }): string {
  const o: Record<string, string> = {};
  if (m.name.trim()) o.name = m.name.trim();
  if (m.desc.trim()) o.desc = m.desc.trim();
  if (m.url.trim()) o.url = m.url.trim();
  if (m.kind && m.kind.trim()) o.kind = m.kind.trim();
  return JSON.stringify(o);
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** The bundled demo: resources whose endpoint ends in /polymarket-rewards unlock a live screener. */
export const isScreener = (m: Meta) => !!m.path && /\/polymarket-rewards\b/.test(m.path);
