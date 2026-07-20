import { Injectable, Logger } from '@nestjs/common';

export interface BlockSignal {
  blocked: boolean;
  reason?: string;
  evidence?: string;
  /**
   * True only when the page CANNOT be classified from a single sample — i.e. the
   * marketplace's generic error page, which is served both for real 5xx blips and
   * as a soft block.
   *
   * Callers may retry an ambiguous signal exactly once to disambiguate it (see
   * SeleniumAdapterBase.navigate). Everything else is an EXPLICIT refusal — a
   * CAPTCHA, a challenge, a named anti-bot vendor — where the site has told us no
   * in words. Those must never be retried: re-asking a question that was already
   * answered is what a retry loop is, and it is what deepens the throttle.
   *
   * Default false. A new signature is an explicit refusal unless proven otherwise.
   */
  ambiguous?: boolean;

  /**
   * True when the page is a HOLDING page that hands control back on its own — the
   * "checking your browser" interstitial some anti-bot vendors show while they run
   * a JS check, after which they redirect to the page originally requested.
   *
   * Distinct from `ambiguous`, and the difference is what the caller does about it.
   * An ambiguous page cannot be classified, so the answer is to fetch it AGAIN.
   * A self-resolving page has classified itself — it is telling us to wait — so the
   * answer is to WAIT, which costs no request at all. Reloading one of these
   * actually restarts whatever check was already in progress.
   *
   * Set it only where waiting has been OBSERVED to work. Etsy's DataDome challenge
   * looks like a holding page and is not one: measured 2026-07-20 it sat unchanged
   * for 63s across two reloads. Marking that self-resolving would buy nothing and
   * make every Etsy failure a minute slower to report.
   *
   * Default false, same as `ambiguous`, and for the same reason.
   */
  selfResolving?: boolean;
}

@Injectable()
export class BlockDetectorService {
  private readonly logger = new Logger(BlockDetectorService.name);

  /**
   * Matched against page HTML, case-insensitive.
   *
   * `ambiguous` is opt-in and rare — see BlockSignal. Omit it unless the page
   * genuinely cannot be told apart from a transient error, because it is the one
   * flag that permits a caller to knock a second time.
   */
  private readonly signatures: Array<{
    pattern: RegExp;
    reason: string;
    ambiguous?: boolean;
    selfResolving?: boolean;
  }> = [
    // Amazon
    {
      pattern: /images-na\.ssl-images-amazon\.com\/captcha/i,
      reason: 'Amazon CAPTCHA page',
    },
    {
      pattern: /Enter the characters you see below/i,
      reason: 'Amazon CAPTCHA challenge',
    },
    {
      pattern: /Sorry,?\s*we just need to make sure you'?re not a robot/i,
      reason: 'Amazon bot check',
    },
    {
      pattern: /To discuss automated access to Amazon data/i,
      reason: 'Amazon automated-access notice',
    },
    {
      pattern: /api-services-support@amazon\.com/i,
      reason: 'Amazon automated-access notice',
    },

    // eBay
    {
      /**
       * Distil/Imperva's holding page. It is worded as one ("...we need to make
       * sure you're not a robot" / "you will be redirected"), runs a JS check, and
       * sends the browser on to the requested URL when it passes. Waiting is what
       * it asks for and costs no request, so it is self-resolving rather than a
       * wall — but bounded by CRAWL_INTERSTITIAL_WAIT_MS, because it does not
       * always pass.
       */
      pattern: /Pardon Our Interruption/i,
      reason: 'eBay/Distil interstitial',
      selfResolving: true,
    },
    // An actual CAPTCHA, not a holding page: it waits for a HUMAN, not a timer.
    { pattern: /ebay\.com\/splashui\/captcha/i, reason: 'eBay CAPTCHA' },

    // Etsy
    {
      /**
       * Etsy's own device challenge, which behaves like eBay's interstitial —
       * it re-checks and continues. Distinct from the DataDome challenge below,
       * which does NOT.
       */
      pattern: /you'?re browsing Etsy from a device we don'?t recognize/i,
      reason: 'Etsy device challenge',
      selfResolving: true,
    },
    {
      pattern: /Access is temporarily restricted/i,
      reason: 'Etsy access restriction',
    },

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
      // The ONLY ambiguous signature. The reason string has always said "soft
      // block OR transient error"; this flag is that sentence made actionable, so
      // one retry can settle which it was instead of us guessing wall every time.
      ambiguous: true,
    },
    {
      pattern: /Something went wrong on our end/i,
      reason: 'Marketplace error page — soft block or transient error',
      // The ONLY ambiguous signature. The reason string has always said "soft
      // block OR transient error"; this flag is that sentence made actionable, so
      // one retry can settle which it was instead of us guessing wall every time.
      ambiguous: true,
    },

    // Generic vendors
    { pattern: /<title>\s*Just a moment/i, reason: 'Cloudflare challenge' },
    {
      pattern: /cf-browser-verification|cf_chl_opt|__cf_chl/i,
      reason: 'Cloudflare challenge',
    },
    {
      pattern: /Access Denied.*Reference\s*#/is,
      reason: 'Akamai / CDN access denied',
    },
    {
      pattern: /Request unsuccessful\.\s*Incapsula/i,
      reason: 'Imperva/Incapsula block',
    },
    { pattern: /PerimeterX|px-captcha/i, reason: 'PerimeterX challenge' },
    { pattern: /\bare you a (human|robot)\b/i, reason: 'Generic bot check' },

    // Deliberately loose: near-miss phrasing is how a signature list rots. An
    // earlier pattern used Google's exact "unusual traffic from your computer
    // network" and silently missed Etsy's "unusual activity from your device".
    {
      pattern:
        /unusual (traffic|activity)\s+(from|on)\s+your\s+(computer\s+)?(device|network|connection)/i,
      reason: 'Anti-bot wall: "unusual activity" notice',
    },
    {
      pattern: /automated\s*\(?bot\)?\s*activity/i,
      reason: 'Anti-bot wall: automated activity detected',
    },
    {
      pattern:
        /(access|your request)\s+(is|has been|was)\s+(temporarily\s+)?(restricted|blocked|denied)/i,
      reason: 'Anti-bot wall: access restricted',
    },
    {
      pattern:
        /(detected|suspicious)\s+(unusual|automated|suspicious)\s+(activity|behaviou?r|traffic)/i,
      reason: 'Anti-bot wall: suspicious activity notice',
    },
    {
      pattern:
        /use of (developer|inspection)(\s+or\s+(developer|inspection))?\s+tools/i,
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
      /**
       * A challenge carrying a RETURN URL is a holding page, not a wall.
       *
       * eBay bounces to /splashui/challenge?...&ru=<the page we asked for>, runs
       * its check, and forwards to `ru` on its own. Measured 2026-07-20: landed on
       * the challenge, and 3s later — untouched — it was back on the search page
       * with 62 results.
       *
       * That parameter is the discriminator, and it is the site telling us its own
       * intent: a page that means to refuse you does not carry directions back to
       * where you were going. Treating these as refusals cost a full BLOCK — eBay
       * went to backoff step 12, a 900s hold, for a page that resolved in three
       * seconds.
       *
       * A CAPTCHA path is excluded even when it carries `ru`: that one waits for a
       * human, and no amount of waiting substitutes for one.
       */
      const returnsTo = /[?&](ru|returnUrl|return_to)=/i.test(url);
      const isCaptcha = /captcha/i.test(url);
      const holding = returnsTo && !isCaptcha;

      return {
        blocked: true,
        reason: holding
          ? 'Challenge interstitial (carries a return URL)'
          : 'Redirected to a challenge URL',
        evidence: url,
        selfResolving: holding,
      };
    }

    // DataDome bounces back to the requested URL with its own params attached,
    // so the path still looks legitimate and the body renders empty. This param
    // is the only clean tell.
    if (url && /[?&](dd_referrer|datadome)=/i.test(url)) {
      return {
        blocked: true,
        reason: 'DataDome anti-bot challenge',
        evidence: url,
      };
    }

    if (html && /datadome|geo\.captcha-delivery\.com/i.test(html)) {
      return {
        blocked: true,
        reason: 'DataDome anti-bot challenge',
        evidence: 'DataDome script present',
      };
    }

    // Title as well as body: the title is often the wall's clearest statement
    // about itself ("Access is temporarily restricted").
    for (const { pattern, reason, ambiguous, selfResolving } of this
      .signatures) {
      for (const haystack of [title, html]) {
        if (!haystack) continue;
        const match = pattern.exec(haystack);
        if (match) {
          return {
            blocked: true,
            reason,
            evidence: excerpt(match[0]),
            ambiguous: ambiguous === true,
            selfResolving: selfResolving === true,
          };
        }
      }
    }

    // Backstop for challenge titles that carry no known body phrase.
    if (
      title &&
      /^\s*(robot check|access denied|just a moment|pardon our interruption)/i.test(
        title,
      )
    ) {
      return {
        blocked: true,
        reason: `Challenge page title: "${title}"`,
        evidence: title,
      };
    }

    return { blocked: false };
  }

  logIfBlocked(signal: BlockSignal, context: string): void {
    if (signal.blocked) {
      this.logger.warn(
        `BLOCKED at ${context}: ${signal.reason} — ${signal.evidence ?? ''}`,
      );
    }
  }
}

function excerpt(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
