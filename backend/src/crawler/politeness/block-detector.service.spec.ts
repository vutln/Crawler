import { BlockDetectorService } from './block-detector.service';

/**
 * The block detector is the only thing standing between "the site refused us"
 * and a run that reports SUCCEEDED with 0 products — a lie that looks exactly
 * like a search with no matches.
 *
 * Every signature here comes from a page a real site actually served.
 */
describe('BlockDetectorService', () => {
  let detector: BlockDetectorService;

  beforeEach(() => {
    detector = new BlockDetectorService();
  });

  describe('real anti-bot pages', () => {
    /**
     * REGRESSION — reported from a live Etsy crawl that returned SUCCEEDED / 0 items.
     *
     * The detector had /unusual traffic from your computer network/ (Google's
     * exact phrasing) and Etsy says "unusual activity from your device or
     * network". One word apart; the signature list looked like it covered this
     * and did not. Verbatim text from the served page:
     */
    const ETSY_RESTRICTED = `
      <html><head><title>Access is temporarily restricted</title></head><body>
        <h1>Access is temporarily restricted</h1>
        <p>We detected unusual activity from your device or network.</p>
        <p>Reasons may include:</p>
        <ul>
          <li>Rapid taps or clicks</li>
          <li>JavaScript disabled or not working</li>
          <li>Automated (bot) activity on your network (IP 14.241.228.16)</li>
          <li>Use of developer or inspection tools</li>
        </ul>
        <p>Need help? Submit feedback.</p>
        <p>ID: dd57a576-a44c-a011-a57b-0a1bd9523fc4</p>
      </body></html>`;

    it('detects the Etsy "Access is temporarily restricted" wall', () => {
      const signal = detector.inspect({ html: ETSY_RESTRICTED });
      expect(signal.blocked).toBe(true);
      expect(signal.reason).toBeTruthy();
    });

    it('detects it from the page title alone, before scanning the DOM', () => {
      const signal = detector.inspect({
        title: 'Access is temporarily restricted',
      });
      expect(signal.blocked).toBe(true);
    });

    // Each phrase is an independent hook — the wall is caught even if the site
    // rewords the others.
    it.each([
      [
        'unusual activity notice',
        'We detected unusual activity from your device or network.',
      ],
      [
        'automated bot activity',
        'Automated (bot) activity on your network (IP 1.2.3.4)',
      ],
      ['access restricted', 'Access is temporarily restricted'],
      ['devtools notice', 'Use of developer or inspection tools'],
    ])('independently detects: %s', (_label, text) => {
      expect(
        detector.inspect({ html: `<html><body>${text}</body></html>` }).blocked,
      ).toBe(true);
    });

    it('still detects the Google-style phrasing it originally had', () => {
      const signal = detector.inspect({
        html: 'Our systems have detected unusual traffic from your computer network.',
      });
      expect(signal.blocked).toBe(true);
    });

    /**
     * REGRESSION — reported from a live Amazon crawl of /s?k=Tungsten%20Cube
     * that had SUCCEEDED the day before.
     *
     * Amazon served its "Dogs of Amazon" error page. No signature matched it, so
     * the run was only caught by the bodyChars=0 backstop in diagnoseEmptyPage()
     * and reported "almost certainly a JavaScript anti-bot challenge" — the wrong
     * reason, and luck rather than detection. Had the page's text rendered (>50
     * chars, which is what the operator saw in the browser), nothing would have
     * fired and the run would have reported SUCCEEDED / 0 items.
     *
     * Title verbatim from the run's evidence field:
     */
    const AMAZON_DOGS = `
      <html><head><title>Sorry! Something went wrong!</title></head><body>
        <h1>Sorry! Something went wrong on our end.</h1>
        <p>Please go back and try again or go to Amazon's home page.</p>
        <img alt="Dogs of Amazon"/>
      </body></html>`;

    it('detects the Amazon "Dogs of Amazon" error page', () => {
      const signal = detector.inspect({ html: AMAZON_DOGS });
      expect(signal.blocked).toBe(true);
      // Reason is no longer Amazon-specific: eBay serves the same page, and the
      // adapter prefixes the marketplace onto it. See EBAY_ERROR_PAGE below.
      expect(signal.reason).toMatch(/error page/i);
    });

    /**
     * REGRESSION — reported from a live eBay crawl that returned SUCCEEDED / 0 items.
     *
     * eBay serves the same house error page as Amazon, and every layer missed it:
     *
     *   1. The signature was scoped to Amazon as /Sorry!\s*Something went wrong/.
     *      eBay's reads "SORRY Something went wrong on our end" — no exclamation
     *      mark. One character, and the pattern skipped it.
     *   2. Its ~190 chars of body text cleared diagnoseEmptyPage's 50-char
     *      empty-body backstop, so the last-resort net missed it too.
     *
     * So parseSearchPage returned [], search() saw an empty page and stopped, and
     * the run reported SUCCEEDED / 0 — indistinguishable from "eBay has no film
     * cameras", while eBay was in fact refusing every request.
     *
     * The second trap is why the two hooks exist. inspect() scans getPageSource(),
     * and eBay splits the phrase across elements, so the obvious pattern written by
     * reading the rendered page matches text that is not in the source:
     *
     *   <p class="error-header__headline">SORRY</p><div id="error-info"><p>Something went wrong on our end</p>
     *
     * Verbatim source from https://www.ebay.com/sch/i.html?_nkw=vintage+film+camera:
     */
    const EBAY_ERROR_PAGE =
      `<html lang="en"><head><meta name="robots" content="noindex,nofollow">` +
      `<title>Error Page | eBay</title></head><body><main class="main-content">` +
      `<div class="status--container"><div class="error-header">` +
      `<div class="error-header__text-block">` +
      `<p class="error-header__headline">SORRY</p>` +
      `<div id="error-info"><p>Something went wrong on our end</p><hr>` +
      `<p class="reference-id">0.83e6ab71.1784262567.a91819ea</p><hr>` +
      `<p>Please go back and try again<br>or go to eBay Homepage.</p></div>` +
      `<a class="fake-btn" href="https://www.ebay.com">Go to homepage</a>` +
      `</div></div></div></main></body></html>`;

    it('detects the eBay error page, whose phrasing carries no exclamation mark', () => {
      const signal = detector.inspect({
        html: EBAY_ERROR_PAGE,
        title: 'Error Page | eBay',
      });
      expect(signal.blocked).toBe(true);
      expect(signal.reason).toMatch(/error page/i);
    });

    /**
     * The `ambiguous` flag is what licenses navigate() to knock a second time, so
     * its blast radius has to stay exactly one signature wide.
     *
     * The marketplace error page earns it because it genuinely cannot be told from
     * a 5xx on one sample — the reason string has always said "soft block OR
     * transient error". Everything else here is the site refusing us in words, and
     * re-asking an answered question is a retry loop.
     */
    it('marks ONLY the marketplace error page ambiguous', () => {
      expect(detector.inspect({ html: AMAZON_DOGS }).ambiguous).toBe(true);
      expect(detector.inspect({ html: EBAY_ERROR_PAGE }).ambiguous).toBe(true);
    });

    it.each([
      ['Amazon CAPTCHA', 'Enter the characters you see below'],
      [
        'Amazon bot check',
        "Sorry, we just need to make sure you're not a robot",
      ],
      ['eBay interstitial', '<h1>Pardon Our Interruption</h1>'],
      ['Cloudflare', '<div class="cf-browser-verification">'],
      ['PerimeterX', '<div id="px-captcha"></div>'],
      ['Etsy restriction', 'Access is temporarily restricted'],
    ])('treats %s as an explicit refusal, never retryable', (_label, html) => {
      const signal = detector.inspect({ html });
      expect(signal.blocked).toBe(true);
      expect(signal.ambiguous).toBe(false);
    });

    it('reports a clean page as neither blocked nor ambiguous', () => {
      const signal = detector.inspect({
        html: '<html><body>real results</body></html>',
      });
      expect(signal.blocked).toBe(false);
      expect(signal.ambiguous).toBeUndefined();
    });

    it('matches eBay across the element boundary, not just the rendered text', () => {
      // The half that does the work: "SORRY" and the phrase are in sibling nodes,
      // so a \s*-bridged pattern would pass this page as healthy.
      const signal = detector.inspect({
        html: '<p class="x">SORRY</p><div><p>Something went wrong on our end</p></div>',
      });
      expect(signal.blocked).toBe(true);
    });

    it('does not flag a healthy eBay result page', () => {
      const healthy =
        '<li class="s-item"><h3 class="s-item__title">Canon AE-1</h3>' +
        '<span class="s-item__price">$89.00</span></li>';
      expect(
        detector.inspect({ html: healthy, title: 'vintage film camera | eBay' })
          .blocked,
      ).toBe(false);
    });

    it('detects it from the title alone, before the 15s render timeout', () => {
      // navigate() -> assertNotBlocked() sees only the title here. Catching it at
      // this point is what turns a 16s run into a ~1s one with an honest reason.
      const signal = detector.inspect({
        title: 'Sorry! Something went wrong!',
      });
      expect(signal.blocked).toBe(true);
    });

    it.each([
      ['Amazon CAPTCHA', 'Enter the characters you see below'],
      [
        'Amazon automated-access',
        'To discuss automated access to Amazon data please contact',
      ],
      ['eBay interstitial', '<h1>Pardon Our Interruption</h1>'],
      ['eBay captcha url', 'https://www.ebay.com/splashui/captcha?foo=1'],
      ['Cloudflare', '<div class="cf-browser-verification">'],
      ['Incapsula', 'Request unsuccessful. Incapsula incident ID: 123'],
      ['PerimeterX', '<div id="px-captcha"></div>'],
    ])('detects %s', (_label, html) => {
      expect(detector.inspect({ html }).blocked).toBe(true);
    });
  });

  describe('challenge URLs and titles', () => {
    it('flags a redirect to a challenge URL without scanning HTML', () => {
      const signal = detector.inspect({
        url: 'https://www.ebay.com/splashui/challenge?ap=1',
      });
      expect(signal.blocked).toBe(true);
      expect(signal.reason).toMatch(/challenge URL/i);
    });

    it.each([
      'Robot Check',
      'Access Denied',
      'Just a moment...',
      'Pardon Our Interruption',
    ])('flags challenge page title: %s', (title) => {
      expect(detector.inspect({ title }).blocked).toBe(true);
    });

    /**
     * A challenge that carries a RETURN URL is a holding page.
     *
     * This exact URL came out of a real BLOCKED run. eBay bounced to it, and 3s
     * later — untouched — the browser was back on the search page with 62 results.
     * Classifying it as a refusal cost a full block: backoff step 12, a 900s hold,
     * for a page that was about to hand over the data.
     *
     * `ru` is the site stating its own intent. A page that means to refuse you does
     * not carry directions back to where you were going.
     */
    it('marks a challenge carrying a return URL as self-resolving', () => {
      const signal = detector.inspect({
        url:
          'https://www.ebay.com/splashui/challenge?ap=1&appName=orch&ru=' +
          'https%3A%2F%2Fwww.ebay.com%2Fsch%2Fi.html%3F_nkw%3Dharry%2520potter%2520shirt' +
          '&iid=2f8f9e6e-0989-4dbf-a893-919b2585d2be',
      });

      expect(signal.blocked).toBe(true);
      expect(signal.selfResolving).toBe(true);
      expect(signal.reason).toMatch(/return URL/i);
    });

    /**
     * THE LINE THAT MUST NOT MOVE. A CAPTCHA waits for a HUMAN, and no amount of
     * waiting substitutes for one — even though it carries the same `ru` param.
     */
    it('never marks a CAPTCHA self-resolving, even with a return URL', () => {
      const signal = detector.inspect({
        url: 'https://www.ebay.com/splashui/captcha?ru=https%3A%2F%2Fwww.ebay.com%2Fsch',
      });

      expect(signal.blocked).toBe(true);
      expect(signal.selfResolving).not.toBe(true);
    });

    /** No return URL means no stated intent to send us back — treat as a wall. */
    it('does not mark a bare challenge URL self-resolving', () => {
      const signal = detector.inspect({
        url: 'https://www.ebay.com/splashui/challenge?ap=1',
      });

      expect(signal.blocked).toBe(true);
      expect(signal.selfResolving).not.toBe(true);
    });
  });

  /**
   * False positives are expensive in a different way: they'd turn a genuinely
   * empty search into a fake BLOCKED and send you chasing a wall that isn't there.
   */
  describe('does not cry wolf on legitimate pages', () => {
    it('passes a normal search results page', () => {
      const html = `
        <html><head><title>mechanical keyboard | eBay</title></head><body>
          <ul class="srp-results">
            <li class="s-item"><span class="s-item__title">Keychron K2</span>
            <span class="s-item__price">$89.99</span></li>
          </ul>
        </body></html>`;
      expect(
        detector.inspect({
          html,
          title: 'mechanical keyboard | eBay',
          url: 'https://www.ebay.com/sch/i.html?_nkw=x',
        }).blocked,
      ).toBe(false);
    });

    it('passes a genuinely empty result page', () => {
      const html = `
        <html><head><title>No results | Etsy</title></head><body>
          <p>Sorry, we couldn't find any results for "asdfghjkl".</p>
        </body></html>`;
      expect(
        detector.inspect({ html, title: 'No results | Etsy' }).blocked,
      ).toBe(false);
    });

    it('passes a product page that merely mentions robots', () => {
      // "Robot Vacuum" must not trip the /are you a (human|robot)/ check.
      const html =
        '<html><body><h1>Robot Vacuum Cleaner, Automated Home Assistant</h1></body></html>';
      expect(detector.inspect({ html }).blocked).toBe(false);
    });

    it('passes a review that merely says something went wrong', () => {
      // The Amazon error signature keys on its house phrasing ("Sorry!" then
      // "Something went wrong"). Ordinary prose using those words apart must not
      // turn a real results page into a fake BLOCKED.
      const html = `
        <html><head><title>tungsten cube | Amazon.com</title></head><body>
          <div data-asin="B0CYY6SFYG"><span>Tungsten Cube 1.5"</span>
          <p>Two stars — something went wrong with my order and support was slow.
             Sorry, but I expected better.</p></div>
        </body></html>`;
      expect(
        detector.inspect({ html, title: 'tungsten cube | Amazon.com' }).blocked,
      ).toBe(false);
    });

    it('passes an empty input', () => {
      expect(detector.inspect({}).blocked).toBe(false);
      expect(detector.inspect({ html: '' }).blocked).toBe(false);
    });
  });

  it('returns a trimmed evidence excerpt for the run record', () => {
    const signal = detector.inspect({
      html: `<p>We detected unusual   activity\n from your device or network.</p>`,
    });
    expect(signal.blocked).toBe(true);
    expect(signal.evidence).toBeTruthy();
    // Collapsed whitespace so it reads cleanly in the dashboard's error column.
    expect(signal.evidence).not.toMatch(/\s{2,}|\n/);
  });
});
