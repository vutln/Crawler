import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type transport } from 'winston';
import {
  COMBINED_LOG_FILENAME,
  ERROR_LOG_FILENAME,
  createWinstonOptions,
  resolveLogDirectory,
} from './winston.config';

interface FileTransportShape extends transport {
  dirname: string;
  filename: string;
  level?: string;
  maxsize?: number;
  maxFiles?: number;
  tailable?: boolean;
}

function configured(overrides: Record<string, unknown> = {}): ConfigService {
  return new ConfigService({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    LOG_DIR: 'logs',
    LOG_MAX_SIZE: 10_485_760,
    LOG_MAX_FILES: 5,
    ...overrides,
  });
}

function fileTransports(
  options: ReturnType<typeof createWinstonOptions>,
): FileTransportShape[] {
  const configuredTransports = Array.isArray(options.transports)
    ? options.transports
    : [options.transports];

  return configuredTransports.filter(
    (item): item is FileTransportShape => item?.constructor.name === 'File',
  );
}

describe('createWinstonOptions', () => {
  it('configures combined and error logs with bounded rotation', () => {
    const options = createWinstonOptions(
      configured({
        LOG_LEVEL: 'debug',
        LOG_MAX_SIZE: 4096,
        LOG_MAX_FILES: 3,
      }),
    );

    const files = fileTransports(options);

    expect(options.level).toBe('debug');
    expect(files).toHaveLength(2);
    expect(files.map((item) => item.filename)).toEqual([
      COMBINED_LOG_FILENAME,
      ERROR_LOG_FILENAME,
    ]);

    expect(files[0]).toMatchObject({
      level: 'debug',
      maxsize: 4096,
      maxFiles: 3,
      tailable: true,
    });

    expect(files[1]).toMatchObject({
      level: 'error',
    });
  });

  it('resolves relative directories from the backend root', () => {
    expect(resolveLogDirectory('logs')).toMatch(/backend[\\/]logs$/);
  });

  it('writes structured JSON metadata to combined.log', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'crawler-winston-'));

    try {
      const options = createWinstonOptions(
        configured({
          LOG_DIR: directory,
        }),
      );

      const logger = createLogger({
        ...options,
        transports: fileTransports(options),
      });

      logger.info('Run completed', {
        runId: 'run-123',
        jobId: 'job-456',
      });

      await new Promise<void>((resolve, reject) => {
        logger.once('error', reject);
        logger.once('finish', resolve);
        logger.end();
      });

      const line = readFileSync(
        join(directory, COMBINED_LOG_FILENAME),
        'utf8',
      ).trim();

      expect(JSON.parse(line)).toMatchObject({
        level: 'info',
        message: 'Run completed',
        runId: 'run-123',
        jobId: 'job-456',
        service: 'e-commerce-collector',
      });
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});
