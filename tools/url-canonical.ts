/**
 * url-canonical.ts — strip per-impression tracking from job URLs.
 *
 * Why this matters: Seek serves the same job_id under different
 * `#sol=<token>` hash fragments per search impression. LinkedIn's job
 * URLs vary by `?refId=`, `?trackingId=`, `?currentJobId=`. Each variant
 * looks unique to a dedup that hashes the raw URL — so the harness ends
 * up with the same role multiple times.
 *
 * The fix is a per-channel canonicaliser that keeps the stable bits
 * (host + path + job-id-bearing query param) and drops everything else.
 * Channel modules pass discovered URLs through `canonicaliseUrl(channel,
 * url)` BEFORE calling `opportunityIdFor(channel, canonicalUrl)`.
 */

export function canonicaliseUrl(channel: string, raw: string): string {
  if (!raw) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  switch (channel) {
    case "seek": {
      // Pattern: https://www.seek.com.au/job/<id>[?type=...&ref=...&origin=...][#sol=...]
      // Stable bit is /job/<id>. Drop everything else.
      const m = url.pathname.match(/^\/job\/(\d+)/);
      if (m) return `https://www.seek.com.au/job/${m[1]}`;
      // External-apply URLs go off-platform; keep them as-is.
      return raw;
    }

    case "linkedin_jobs": {
      // Pattern: https://www.linkedin.com/jobs/view/<id>?refId=...&trackingId=...
      // Also: https://www.linkedin.com/jobs/search/?currentJobId=<id>&...
      const viewMatch = url.pathname.match(/^\/jobs\/view\/(\d+)/);
      if (viewMatch) return `https://www.linkedin.com/jobs/view/${viewMatch[1]}/`;
      const searchMatch = url.searchParams.get("currentJobId");
      if (searchMatch) return `https://www.linkedin.com/jobs/view/${searchMatch}/`;
      // Strip query + hash for anything else under linkedin.com/jobs/
      url.search = "";
      url.hash = "";
      return url.toString();
    }

    case "linkedin_posts": {
      // Pattern: https://www.linkedin.com/feed/update/urn:li:activity:<id>/
      // Already mostly clean — just strip query + hash defensively.
      url.search = "";
      url.hash = "";
      return url.toString();
    }

    case "hn_who_is_hiring": {
      // Pattern: https://news.ycombinator.com/item?id=<id> — keep id, drop everything else.
      const id = url.searchParams.get("id");
      if (id) return `https://news.ycombinator.com/item?id=${id}`;
      return raw;
    }

    case "hays":
    case "talenza":
    case "paxus":
    case "robert_half":
    case "peoplebank":
    case "wellfound":
    default: {
      // Generic fallback: strip hash and known tracking params.
      const tracking = new Set([
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "ref", "refId", "trackingId", "source", "src", "gclid", "fbclid",
        "origin", "type", "lifestyle",
      ]);
      for (const key of [...url.searchParams.keys()]) {
        if (tracking.has(key)) url.searchParams.delete(key);
      }
      url.hash = "";
      return url.toString();
    }
  }
}
