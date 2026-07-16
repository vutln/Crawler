import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/**
 * Serves captured HTML fixtures over http:// on an ephemeral port.
 *
 * Why a real HTTP server instead of file:// URLs — file:// triggers Chrome's
 * strictest origin rules, which break relative asset loading and make some DOM
 * APIs behave differently than they do on a real page. Serving over HTTP means
 * the fixture renders the way the live page did.
 *
 * Port 0 = let the OS pick. Hard-coding a port makes parallel Jest workers
 * collide with EADDRINUSE.
 */
export class FixtureServer {
  private server?: Server;
  private port?: number;
  private readonly root: string;

  constructor(root = join(__dirname)) {
    this.root = resolve(root);
  }

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req.url ?? '/', res);
    });

    await new Promise<void>((res) => this.server!.listen(0, '127.0.0.1', res));
    this.port = (this.server!.address() as AddressInfo).port;
    return this.port;
  }

  private async handle(url: string, res: import('node:http').ServerResponse): Promise<void> {
    const requested = decodeURIComponent(url.split('?')[0]);

    // Path traversal guard. Fixtures are local and trusted, but a test harness
    // that serves arbitrary disk paths is a bad habit to leave lying around.
    const target = normalize(join(this.root, requested));
    if (!target.startsWith(this.root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const info = await stat(target);
      if (!info.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        'Content-Length': info.size,
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }

  url(fixturePath: string): string {
    if (this.port === undefined) throw new Error('FixtureServer not started');
    return `http://127.0.0.1:${this.port}/${fixturePath.replace(/^\//, '')}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((res) => this.server!.close(() => res()));
    this.server = undefined;
  }
}
