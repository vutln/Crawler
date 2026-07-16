import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Marketplace } from '../../generated/prisma/client';
import { MARKETPLACE_ADAPTER, type MarketplaceAdapter } from './adapter.interface';

/**
 * Resolves a Marketplace to the best available adapter.
 *
 * Several adapters may claim the same marketplace (e.g. EbayApiAdapter and
 * EbaySeleniumAdapter). Selection is: available ones only, highest priority wins.
 * Because API adapters report unavailable without credentials, the app boots and
 * crawls with zero API keys, then silently upgrades to the API path the moment
 * keys appear in .env — no code change, no config flag.
 */
@Injectable()
export class AdapterRegistry {
  private readonly logger = new Logger(AdapterRegistry.name);
  private readonly byMarketplace = new Map<Marketplace, MarketplaceAdapter[]>();

  constructor(
    @Inject(MARKETPLACE_ADAPTER)
    private readonly adapters: MarketplaceAdapter[],
  ) {
    for (const adapter of this.adapters) {
      const list = this.byMarketplace.get(adapter.marketplace) ?? [];
      list.push(adapter);
      this.byMarketplace.set(adapter.marketplace, list);
    }

    for (const [marketplace, list] of this.byMarketplace) {
      list.sort((a, b) => b.priority - a.priority);
      const chosen = list.find((a) => a.isAvailable());
      this.logger.log(
        `${marketplace}: ${chosen ? `using ${chosen.name}` : 'NO ADAPTER AVAILABLE'}` +
          ` (candidates: ${list.map((a) => `${a.name}${a.isAvailable() ? '' : ' [unavailable]'}`).join(', ')})`,
      );
    }
  }

  /** Best available adapter, or throws with a message that says what to do about it. */
  resolve(marketplace: Marketplace): MarketplaceAdapter {
    const candidates = this.byMarketplace.get(marketplace) ?? [];
    const adapter = candidates.find((a) => a.isAvailable());

    if (!adapter) {
      throw new NotFoundException(
        candidates.length === 0
          ? `No adapter registered for ${marketplace}.`
          : `All adapters for ${marketplace} are unavailable (missing credentials?): ` +
            candidates.map((a) => a.name).join(', '),
      );
    }
    return adapter;
  }

  /** Powers GET /api/stats/overview so the dashboard can show what's wired up. */
  describe(): Array<{
    marketplace: Marketplace;
    active: string | null;
    candidates: Array<{ name: string; available: boolean; priority: number }>;
  }> {
    return [...this.byMarketplace.entries()].map(([marketplace, list]) => ({
      marketplace,
      active: list.find((a) => a.isAvailable())?.name ?? null,
      candidates: list.map((a) => ({
        name: a.name,
        available: a.isAvailable(),
        priority: a.priority,
      })),
    }));
  }
}
