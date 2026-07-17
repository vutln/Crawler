import { Injectable, Logger } from '@nestjs/common';

export interface BlockSignal {
  blocked: boolean;
  reason?: string;
  evidence?: string;
}

@Injectable()
export class BlockDetectorService {
  private readonly logger = new Logger(BlockDetectorService.name);

  /** Matched against page HTML, case-insensitive. */
  private readonly signatures: Array<{ pattern: RegExp; reason: string }> = [
    // Amazon
    { pattern: /images-na\.ssl-images-amazon\.com\/captcha/i, reason: 'Amazon CAPTCHA page' },
    { pattern: /Enter the characters you see below/i, reason: 'Amazon CAPTCHA challenge' },
    { pattern: /Sorry,?\s*we just need to make sure you'?re not a robot/i, reason: 'Amazon bot check' },
    { pattern: /To discuss automated access to Amazon data/i, reason: 'Amazon automated-access notice' },
    { pattern: /api-services-support@amazon\.com/i, reason: 'Amazon automated-access notice' },

    // eBay
    { pattern: /Pardon Our Interruption/i, reason: 'eBay/Distil interstitial' },
    { pattern: /ebay\.com\/splashui\/captcha/i, reason: 'eBay CAPTCHA' },

    // Etsy
    { pattern: /you'?re browsing Etsy from a device we don'?t recognize/i, reason: 'Etsy device challenge' },
    { pattern: /Access is temporarily restricted/i, reason: 'Etsy access restriction' },

    // The marketplace house error page — Amazon's "Dogs of Amazon", eBay's
    // "Error Page | eBay". A generic error page that both sites also serve as a
    // soft block once an IP has made enough automated requests: the same URL that
    // worked yesterday returns this today.
    //
    // Genuinely ambiguous: it can be a real transient 5xx. Classified BLOCKED
    // anyway because it is never a successful search, and FAILED invites a retry
    // loop that deepens the throttle. Repeat-visitor IPs see it far more often
    // than real outages would explain.
    //
    // REGRESSION — this lived under Amazon as /Sorry!\s*Something went wrong/ and
    // silently missed eBay, whose page reads "SORRY Something went wrong on our
    // end": identical wording, no exclamation mark. That page carries ~190 chars
    // of body text, so diagnoseEmptyPage's empty-body backstop (50) cleared it
    // too, and eBay crawls reported SUCCEEDED / 0 items while the site was
    // refusing every request. Exactly the near-miss the Etsy signature below was
    // loosened to prevent — the second time this list has rotted the same way.
    //
    // Vendor-agnostic on purpose: both sites use the phrasing, and the adapter
    // already prefixes the marketplace onto the reason.
    //
    // TWO independent hooks, because what gets scanned is getPageSource() — raw
    // HTML, not rendered text. eBay puts the two halves in separate elements:
    //   <p class="error-header__headline">SORRY</p><div id="error-info"><p>Something went wrong...
    // so no \s* can bridge them, and a pattern built by reading the page in a
    // browser matches text that never appears in the source. Amazon runs them
    // together in one <h1> and in its <title>, where "on our end" is absent.
    // Neither hook alone covers both sites.
    {
      pattern: /Sorry[!,.]?\s*Something went wrong/i,
      reason: 'Marketplace error page — soft block or transient error',
    },
    {
      pattern: /Something went wrong on our end/i,
      reason: 'Marketplace error page — soft block or transient error',
    },

    // Generic vendors
    { pattern: /<title>\s*Just a moment/i, reason: 'Cloudflare challenge' },
    { pattern: /cf-browser-verification|cf_chl_opt|__cf_chl/i, reason: 'Cloudflare challenge' },
    { pattern: /Access Denied.*Reference\s*#/is, reason: 'Akamai / CDN access denied' },
    { pattern: /Request unsuccessful\.\s*Incapsula/i, reason: 'Imperva/Incapsula block' },
    { pattern: /PerimeterX|px-captcha/i, reason: 'PerimeterX challenge' },
    { pattern: /\bare you a (human|robot)\b/i, reason: 'Generic bot check' },

    // Deliberately loose: near-miss phrasing is how a signature list rots. An
    // earlier pattern used Google's exact "unusual traffic from your computer
    // network" and silently missed Etsy's "unusual activity from your device".
    {
      pattern: /unusual (traffic|activity)\s+(from|on)\s+your\s+(computer\s+)?(device|network|connection)/i,
      reason: 'Anti-bot wall: "unusual activity" notice',
    },
    {
      pattern: /automated\s*\(?bot\)?\s*activity/i,
      reason: 'Anti-bot wall: automated activity detected',
    },
    {
      pattern: /(access|your request)\s+(is|has been|was)\s+(temporarily\s+)?(restricted|blocked|denied)/i,
      reason: 'Anti-bot wall: access restricted',
    },
    {
      pattern: /(detected|suspicious)\s+(unusual|automated|suspicious)\s+(activity|behaviou?r|traffic)/i,
      reason: 'Anti-bot wall: suspicious activity notice',
    },
    {
      pattern: /use of (developer|inspection)(\s+or\s+(developer|inspection))?\s+tools/i,
      reason: 'Anti-bot wall: devtools detection notice',
    },
  ];

  /**
   * `title` and `url` are cheap early signals — a redirect to /captcha needs no
   * HTML scan. Kept separate so callers can bail before serializing a big DOM.
   */
  inspect(input: { html?: string; title?: string; url?: string }): BlockSignal {
    const { html, title, url } = input;

    // Cheapest signal: a redirect to a challenge path needs no HTML at all.
    if (url && /\/(captcha|challenge|blocked|errors\/validate)/i.test(url)) {
      return { blocked: true, reason: 'Redirected to a challenge URL', evidence: url };
    }

    // DataDome bounces back to the requested URL with its own params attached,
    // so the path still looks legitimate and the body renders empty. This param
    // is the only clean tell.
    if (url && /[?&](dd_referrer|datadome)=/i.test(url)) {
      return { blocked: true, reason: 'DataDome anti-bot challenge', evidence: url };
    }

    if (html && /datadome|geo\.captcha-delivery\.com/i.test(html)) {
      return { blocked: true, reason: 'DataDome anti-bot challenge', evidence: 'DataDome script present' };
    }

    // Title as well as body: the title is often the wall's clearest statement
    // about itself ("Access is temporarily restricted").
    for (const { pattern, reason } of this.signatures) {
      for (const haystack of [title, html]) {
        if (!haystack) continue;
        const match = pattern.exec(haystack);
        if (match) {
          return { blocked: true, reason, evidence: excerpt(match[0]) };
        }
      }
    }

    // Backstop for challenge titles that carry no known body phrase.
    if (title && /^\s*(robot check|access denied|just a moment|pardon our interruption)/i.test(title)) {
      return { blocked: true, reason: `Challenge page title: "${title}"`, evidence: title };
    }

    return { blocked: false };
  }

  logIfBlocked(signal: BlockSignal, context: string): void {
    if (signal.blocked) {
      this.logger.warn(`BLOCKED at ${context}: ${signal.reason} — ${signal.evidence ?? ''}`);
    }
  }
}

function excerpt(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
