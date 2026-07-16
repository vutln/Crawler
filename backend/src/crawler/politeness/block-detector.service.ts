import { Injectable, Logger } from '@nestjs/common';

export interface BlockSignal {
  blocked: boolean;
  reason?: string;
  evidence?: string;
}

/**
 * Recognises anti-bot walls. Detects and STOPS — never evades or disguises.
 *
 * Needed because a blocked page still returns HTTP 200 with a parseable DOM, so
 * without this a crawl "succeeds" with zero products and looks identical to a
 * search that had no results.
 */
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
