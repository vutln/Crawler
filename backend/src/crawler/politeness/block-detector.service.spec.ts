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
      const signal = detector.inspect({ title: 'Access is temporarily restricted' });
      expect(signal.blocked).toBe(true);
    });

    // Each phrase is an independent hook — the wall is caught even if the site
    // rewords the others.
    it.each([
      ['unusual activity notice', 'We detected unusual activity from your device or network.'],
      ['automated bot activity', 'Automated (bot) activity on your network (IP 1.2.3.4)'],
      ['access restricted', 'Access is temporarily restricted'],
      ['devtools notice', 'Use of developer or inspection tools'],
    ])('independently detects: %s', (_label, text) => {
      expect(detector.inspect({ html: `<html><body>${text}</body></html>` }).blocked).toBe(true);
    });

    it('still detects the Google-style phrasing it originally had', () => {
      const signal = detector.inspect({
        html: 'Our systems have detected unusual traffic from your computer network.',
      });
      expect(signal.blocked).toBe(true);
    });

    it.each([
      ['Amazon CAPTCHA', 'Enter the characters you see below'],
      ['Amazon automated-access', 'To discuss automated access to Amazon data please contact'],
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
      const signal = detector.inspect({ url: 'https://www.ebay.com/splashui/challenge?ap=1' });
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
      expect(detector.inspect({ html, title: 'mechanical keyboard | eBay', url: 'https://www.ebay.com/sch/i.html?_nkw=x' }).blocked).toBe(false);
    });

    it('passes a genuinely empty result page', () => {
      const html = `
        <html><head><title>No results | Etsy</title></head><body>
          <p>Sorry, we couldn't find any results for "asdfghjkl".</p>
        </body></html>`;
      expect(detector.inspect({ html, title: 'No results | Etsy' }).blocked).toBe(false);
    });

    it('passes a product page that merely mentions robots', () => {
      // "Robot Vacuum" must not trip the /are you a (human|robot)/ check.
      const html = '<html><body><h1>Robot Vacuum Cleaner, Automated Home Assistant</h1></body></html>';
      expect(detector.inspect({ html }).blocked).toBe(false);
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
