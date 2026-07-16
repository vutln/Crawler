import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma 7 requires an explicit driver adapter for every datasource — the old
 * "just give it a URL" path is gone. The mariadb driver speaks the MySQL wire
 * protocol and is Prisma's supported adapter for MySQL 8.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const url = new URL(config.getOrThrow<string>('DATABASE_URL'));

    const adapter = new PrismaMariaDb({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      // Credentials are percent-encoded inside a URL; hand the driver the raw values.
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      connectionLimit: 10,
      // Return DECIMAL as string, not JS number. Prices are DECIMAL(12,2) and
      // float rounding on money is a real bug, not a theoretical one.
      decimalAsNumber: false,
      bigIntAsNumber: true,
      timezone: 'Z',
    });

    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to MySQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
