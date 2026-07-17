import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Keyword } from '../generated/prisma/client';
import type { ICrawlQueue } from '../crawler/queue/crawl-queue.interface';
import type { PrismaService } from '../prisma/prisma.service';
import { KeywordsService } from './keywords.service';

/**
 * The keyword list's one invariant: `text` is stored normalized, always.
 *
 * The @unique index in the schema constrains exactly what is stored, so it is only
 * as good as this service. If any write path skipped normalizeText, "Mug ", "mug"
 * and "MUG" would all coexist and the daily sweep would crawl the same term three
 * times across three marketplaces, every day, while the screen showed three rows
 * that look identical.
 */
describe('KeywordsService', () => {
  /** In-memory stand-in for the keyword table, enforcing the same unique constraint. */
  function makeService(seed: string[] = []): {
    service: KeywordsService;
    rows: Keyword[];
  } {
    const rows: Keyword[] = seed.map((text, i) => ({
      id: `kw_${i}`,
      text,
      enabled: true,
      notes: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));

    const prisma = {
      keyword: {
        findMany: ({ where }: { where?: { text?: { in: string[] } } } = {}) => {
          const wanted = where?.text?.in;
          const found = wanted ? rows.filter((r) => wanted.includes(r.text)) : rows;
          return Promise.resolve(found.map((r) => ({ ...r, _count: { products: 0 } })));
        },
        findUnique: ({ where }: { where: { text?: string; id?: string } }) => {
          const found = rows.find((r) =>
            where.text !== undefined ? r.text === where.text : r.id === where.id,
          );
          return Promise.resolve(found ? { ...found, _count: { products: 0 } } : null);
        },
        create: ({ data }: { data: { text: string; enabled?: boolean; notes?: string | null } }) => {
          const row: Keyword = {
            id: `kw_${rows.length}`,
            text: data.text,
            enabled: data.enabled ?? true,
            notes: data.notes ?? null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          };
          rows.push(row);
          return Promise.resolve({ ...row, _count: { products: 0 } });
        },
        createMany: ({ data }: { data: Array<{ text: string }> }) => {
          for (const d of data) {
            // The DB's unique index is the real authority; mirror it here so a
            // service bug can't pass by virtue of a permissive fake.
            if (rows.some((r) => r.text === d.text)) continue;
            rows.push({
              id: `kw_${rows.length}`,
              text: d.text,
              enabled: true,
              notes: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            });
          }
          return Promise.resolve({ count: data.length });
        },
        update: ({ where, data }: { where: { id: string }; data: Partial<Keyword> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve({ ...row, _count: { products: 0 } });
        },
        delete: ({ where }: { where: { id: string } }) => {
          rows.splice(
            rows.findIndex((r) => r.id === where.id),
            1,
          );
          return Promise.resolve({});
        },
      },
    } as unknown as PrismaService;

    const queue = { enqueue: () => Promise.resolve() } as unknown as ICrawlQueue;
    return { service: new KeywordsService(prisma, queue), rows };
  }

  describe('normalizeText — the identity of a keyword', () => {
    it.each([
      ['trims', '  mechanical keyboard  ', 'mechanical keyboard'],
      ['lowercases', 'Mechanical Keyboard', 'mechanical keyboard'],
      // A pasted column is full of these, and "harry  potter" builds the SAME
      // search URL as "harry potter" — a duplicate the operator cannot see.
      ['collapses internal whitespace', 'harry   potter  shirt', 'harry potter shirt'],
      ['collapses tabs and newlines', 'vintage\tfilm\ncamera', 'vintage film camera'],
      ['leaves an already-clean term alone', 'handmade ceramic mug', 'handmade ceramic mug'],
    ])('%s', (_label, input, expected) => {
      expect(KeywordsService.normalizeText(input)).toBe(expected);
    });
  });

  describe('create', () => {
    it('stores the normalized form, not what was typed', async () => {
      const { service, rows } = makeService();
      const dto = await service.create({ text: '  Mechanical   KEYBOARD ' });

      expect(dto.text).toBe('mechanical keyboard');
      expect(rows[0].text).toBe('mechanical keyboard');
    });

    /** Case and spacing variants are the same keyword — that is the whole point. */
    it('rejects a term that only differs by case or spacing', async () => {
      const { service } = makeService(['mechanical keyboard']);
      await expect(service.create({ text: 'Mechanical  Keyboard' })).rejects.toThrow(
        ConflictException,
      );
    });

    /**
     * 400, not 409. A blank keyword collides with nothing — it is simply invalid,
     * and telling a client "conflict" invites it to retry with a different name
     * when the real problem is that it sent whitespace.
     *
     * The DTO cannot catch this: @MinLength(1) sees "   " as three characters, and
     * it only becomes empty after normalizeText collapses it.
     */
    it('rejects a blank term as a bad request, not a conflict', async () => {
      const { service } = makeService();
      await expect(service.create({ text: '   ' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('bulkCreate — the paste path', () => {
    /**
     * The semantic that separates this from POST /keywords: an existing term is a
     * normal outcome, not a client error. Rejecting the whole paste because 3 of 50
     * already exist is exactly what the screen must not do.
     */
    it('adds the new terms and skips the ones already present', async () => {
      const { service } = makeService(['mechanical keyboard']);

      const result = await service.bulkCreate({
        keywords: ['mechanical keyboard', 'harry potter shirt', 'vintage film camera'],
      });

      expect(result.created.map((k) => k.text)).toEqual(['harry potter shirt', 'vintage film camera']);
      expect(result.skipped).toEqual(['mechanical keyboard']);
    });

    it('reports duplicates within the paste separately from ones already on the server', async () => {
      const { service } = makeService(['mechanical keyboard']);

      const result = await service.bulkCreate({
        keywords: ['Harry Potter Shirt', 'harry potter shirt', 'MECHANICAL keyboard'],
      });

      // Same term twice in one paste -> duplicate.
      expect(result.duplicates).toEqual(['harry potter shirt']);
      // Already in the list -> skipped. Different fact, different field.
      expect(result.skipped).toEqual(['mechanical keyboard']);
      expect(result.created.map((k) => k.text)).toEqual(['harry potter shirt']);
    });

    it('normalizes before comparing, so a messy paste cannot smuggle in duplicates', async () => {
      const { service, rows } = makeService();

      await service.bulkCreate({
        keywords: ['  Mug ', 'mug', 'MUG', 'm u g'],
      });

      // 'm u g' is genuinely a different term; the other three are one keyword.
      expect(rows.map((r) => r.text).sort()).toEqual(['m u g', 'mug']);
    });

    it('preserves the pasted order in the response', async () => {
      const { service } = makeService();
      const result = await service.bulkCreate({ keywords: ['zebra', 'apple', 'mango'] });

      // Not sorted — a paste that comes back reordered looks broken.
      expect(result.created.map((k) => k.text)).toEqual(['zebra', 'apple', 'mango']);
    });

    it('drops blank lines instead of creating empty keywords', async () => {
      const { service, rows } = makeService();
      const result = await service.bulkCreate({ keywords: ['mug', '   ', '', '\t'] });

      expect(result.created.map((k) => k.text)).toEqual(['mug']);
      expect(rows).toHaveLength(1);
    });

    it('handles a paste of nothing but blanks without touching the table', async () => {
      const { service, rows } = makeService();
      const result = await service.bulkCreate({ keywords: ['  ', '\n'] });

      expect(result).toEqual({ created: [], skipped: [], duplicates: [] });
      expect(rows).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('normalizes a rename', async () => {
      const { service, rows } = makeService(['mug']);
      await service.update('kw_0', { text: '  Ceramic   MUG ' });
      expect(rows[0].text).toBe('ceramic mug');
    });

    it('rejects a rename that collides with another keyword', async () => {
      const { service } = makeService(['mug', 'keyboard']);
      await expect(service.update('kw_1', { text: 'MUG' })).rejects.toThrow(ConflictException);
    });

    it('allows renaming a keyword to its own normalized form', async () => {
      const { service } = makeService(['mug']);
      await expect(service.update('kw_0', { text: 'Mug' })).resolves.toMatchObject({ text: 'mug' });
    });

    it('can disable without renaming', async () => {
      const { service, rows } = makeService(['mug']);
      await service.update('kw_0', { enabled: false });
      expect(rows[0].enabled).toBe(false);
      expect(rows[0].text).toBe('mug');
    });

    it('404s on an unknown id', async () => {
      const { service } = makeService();
      await expect(service.update('nope', { enabled: false })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the keyword', async () => {
      const { service, rows } = makeService(['mug']);
      await service.remove('kw_0');
      expect(rows).toHaveLength(0);
    });

    it('404s on an unknown id', async () => {
      const { service } = makeService();
      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
