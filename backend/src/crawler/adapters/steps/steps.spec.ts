import type { WebDriver } from 'selenium-webdriver';
import { BlockedError } from '../adapter.interface';
import { enterSession } from './enter-session.step';
import { fillAndSubmit } from './fill-and-submit.step';
import { nextPage } from './next-page.step';
import type { StepRuntime } from './step-runtime';

/**
 * The step library.
 *
 * Steps are plain functions over a StepRuntime, so they test without a browser,
 * without Nest, and without an adapter — which is most of the point of extracting
 * them. The fake below IS the StepRuntime interface, so anything these tests can
 * express, a real adapter can too.
 */
describe('crawl steps', () => {
  const HOME = 'https://www.amazon.com/';
  const SEARCH = 'https://www.amazon.com/s?k=keyboard&page=1';

  function makeRuntime(
    opts: {
      /** URLs whose navigate() throws BlockedError. */
      blocked?: string[];
      /** Selectors that waitForAny should find. Everything else times out. */
      present?: RegExp;
      /** What getCurrentUrl reports after a transition. */
      landsOn?: string;
      /** Elements findElements should report for a selector. */
      elements?: RegExp;
    } = {},
  ) {
    const calls: string[] = [];
    let currentUrl = '';

    const rt: StepRuntime = {
      driver: {
        getCurrentUrl: () => Promise.resolve(opts.landsOn ?? currentUrl),
        findElement: () =>
          Promise.resolve({
            clear: () => Promise.resolve(),
            sendKeys: (v: unknown) => {
              calls.push(`sendKeys:${String(v)}`);
              return Promise.resolve();
            },
          }),
        findElements: (by: { value?: string }) =>
          Promise.resolve(
            opts.elements?.test(by.value ?? '') ? [{ click: () => {} }] : [],
          ),
      } as unknown as WebDriver,
      ctx: {
        maxPages: 2,
        maxItems: 10,
        signal: new AbortController().signal,
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },

      navigate: (url, o) => {
        calls.push(`navigate:${url}${o?.probe ? ':probe' : ''}`);
        currentUrl = url;
        if (opts.blocked?.includes(url)) {
          return Promise.reject(new BlockedError('walled', 'evidence'));
        }
        return Promise.resolve();
      },
      transition: async (act, label) => {
        calls.push(`transition:${label}`);
        await act();
      },
      waitForAny: (selectors) =>
        Promise.resolve(!!opts.present?.test(selectors.join(', '))),
      clickFirst: (selectors) => {
        calls.push(`click:${selectors[0]}`);
        return Promise.resolve(!!opts.elements?.test(selectors.join(', ')));
      },
      textOf: () => Promise.resolve(undefined),
      attrOf: () => Promise.resolve(undefined),
    };

    return { rt, calls };
  }

  describe('enterSession', () => {
    it('uses the homepage when it renders as itself', async () => {
      const { rt, calls } = makeRuntime({ present: /search-box/ });

      const entry = await enterSession(rt, {
        homepage: HOME,
        ready: ['#search-box'],
        fallbackUrl: SEARCH,
      });

      expect(entry).toEqual({ via: 'homepage', url: HOME });
      expect(calls).toEqual([`navigate:${HOME}:probe`]);
    });

    /**
     * THE MEASURED CASE. amazon.com/ intermittently returns a 2KB AWS WAF page
     * with no nav — which LOADS FINE, so only the missing nav reveals it.
     */
    it('falls back when the homepage loads but has no nav', async () => {
      const { rt, calls } = makeRuntime({ present: /nothing/ });

      const entry = await enterSession(rt, {
        homepage: HOME,
        ready: ['#search-box'],
        fallbackUrl: SEARCH,
      });

      expect(entry).toEqual({ via: 'direct', url: SEARCH });
      expect(calls).toEqual([`navigate:${HOME}:probe`, `navigate:${SEARCH}`]);
    });

    it('falls back when the homepage is an outright wall', async () => {
      const { rt, calls } = makeRuntime({
        blocked: [HOME],
        present: /search-box/,
      });

      const entry = await enterSession(rt, {
        homepage: HOME,
        ready: ['#search-box'],
        fallbackUrl: SEARCH,
      });

      expect(entry.via).toBe('direct');
      expect(calls).toContain(`navigate:${SEARCH}`);
    });

    /**
     * THE ONE THAT MAKES THE FALLBACK POSSIBLE AT ALL.
     *
     * Throttle state is keyed by hostname, so the homepage and the search page
     * share a bucket. Charging the probe's block would owe ~128s on that host and
     * navigate()'s cooldown bail would then refuse the fallback outright — the run
     * would fail completely on exactly the WAF the fallback exists to survive.
     */
    it('probes the homepage so a wall there is not charged to the host', async () => {
      const { rt, calls } = makeRuntime({ blocked: [HOME], present: /nope/ });

      await enterSession(rt, {
        homepage: HOME,
        ready: ['#search-box'],
        fallbackUrl: SEARCH,
      });

      expect(calls[0]).toBe(`navigate:${HOME}:probe`);
      // The page we actually want is NOT a probe — a wall there is real evidence.
      expect(calls).toContain(`navigate:${SEARCH}`);
      expect(calls).not.toContain(`navigate:${SEARCH}:probe`);
    });

    it('skips the probe entirely when no homepage is configured', async () => {
      const { rt, calls } = makeRuntime({ present: /anything/ });

      const entry = await enterSession(rt, {
        ready: ['#search-box'],
        fallbackUrl: SEARCH,
      });

      expect(entry).toEqual({ via: 'direct', url: SEARCH });
      expect(calls).toEqual([`navigate:${SEARCH}`]);
    });

    /** A non-block failure is a real fault and must not be swallowed. */
    it('propagates a non-block error rather than falling back', async () => {
      const { rt } = makeRuntime();
      rt.navigate = () => Promise.reject(new Error('robots.txt disallows'));

      await expect(
        enterSession(rt, {
          homepage: HOME,
          ready: ['#search-box'],
          fallbackUrl: SEARCH,
        }),
      ).rejects.toThrow(/robots/);
    });
  });

  describe('fillAndSubmit', () => {
    it('types, submits, and confirms the URL', async () => {
      const { rt, calls } = makeRuntime({
        present: /search-box|s-search-result/,
        landsOn: 'https://www.amazon.com/s?k=keyboard&ref=nb_sb_noss',
      });

      const ok = await fillAndSubmit(rt, {
        input: ['#search-box'],
        value: 'keyboard',
        submit: { via: 'enter' },
        settled: ['div.s-search-result'],
        expectUrl: (u) => u.includes('k=keyboard'),
      });

      expect(ok).toBe(true);
      expect(calls).toContain('sendKeys:keyboard');
      // Submitted through transition() — so it was throttled and block-checked.
      expect(calls.some((c) => c.startsWith('transition:'))).toBe(true);
    });

    /**
     * THE REASON THE URL CHECK EXISTS. Amazon's autocomplete overlay can swallow
     * Enter and search a SUGGESTION instead — every price valid, wrong dataset.
     * Silent without this.
     */
    it('reports failure when the search landed on a different query', async () => {
      const { rt } = makeRuntime({
        present: /search-box|s-search-result/,
        landsOn: 'https://www.amazon.com/s?k=keyboard+for+women',
      });

      const ok = await fillAndSubmit(rt, {
        input: ['#search-box'],
        value: 'keyboard',
        submit: { via: 'enter' },
        settled: ['div.s-search-result'],
        expectUrl: (u) => u.includes('k=keyboard&'),
      });

      expect(ok).toBe(false); // caller falls back to a built URL
    });

    it('reports failure when the input never appears', async () => {
      const { rt, calls } = makeRuntime({ present: /nothing/ });

      const ok = await fillAndSubmit(rt, {
        input: ['#search-box'],
        value: 'keyboard',
        submit: { via: 'enter' },
        settled: ['div.s-search-result'],
        expectUrl: () => true,
      });

      expect(ok).toBe(false);
      expect(calls).not.toContain('sendKeys:keyboard');
    });

    it('supports a click strategy instead of Enter', async () => {
      const { rt, calls } = makeRuntime({
        present: /search-box|s-search-result/,
        elements: /submit-btn/,
        landsOn: SEARCH,
      });

      const ok = await fillAndSubmit(rt, {
        input: ['#search-box'],
        value: 'keyboard',
        submit: { via: 'click', selector: ['#submit-btn'] },
        settled: ['div.s-search-result'],
        expectUrl: () => true,
      });

      expect(ok).toBe(true);
      expect(calls).toContain('click:#submit-btn');
    });
  });

  describe('nextPage', () => {
    it('navigates by URL in url mode', async () => {
      const { rt, calls } = makeRuntime();

      const advanced = await nextPage(
        rt,
        { mode: 'url', url: (p) => `https://x/s?page=${p}` },
        2,
      );

      expect(advanced).toBe(true);
      expect(calls).toEqual(['navigate:https://x/s?page=2']);
    });

    it('clicks the next link in click mode', async () => {
      const { rt, calls } = makeRuntime({ elements: /pagination-next/ });

      const advanced = await nextPage(
        rt,
        {
          mode: 'click',
          next: ['a.pagination-next'],
          settled: ['div.result'],
        },
        2,
      );

      expect(advanced).toBe(true);
      expect(calls).toContain('click:a.pagination-next');
      expect(calls.some((c) => c.startsWith('transition:'))).toBe(true);
    });

    /**
     * Click mode can KNOW it is done — a missing next link is a definite last
     * page, which is a better answer than inferring it from an empty parse.
     */
    it('reports the last page when there is no next link', async () => {
      const { rt, calls } = makeRuntime({ elements: /nothing/ });

      const advanced = await nextPage(
        rt,
        { mode: 'click', next: ['a.pagination-next'], settled: ['div.result'] },
        2,
      );

      expect(advanced).toBe(false);
      expect(calls).toEqual([]); // no request made at all
    });
  });
});
