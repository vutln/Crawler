import { Controller, Get, Injectable, Module } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

export class HealthDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded'] }) status!:
    'ok' | 'degraded';
  @ApiProperty({ example: 'up', enum: ['up', 'down'] }) database!:
    'up' | 'down';
  @ApiProperty({ description: 'Process uptime in seconds' }) uptime!: number;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthDto> {
    let database: 'up' | 'down' = 'down';
    try {
      // Actually touch the DB. A health check that only reports "the process is
      // running" tells you nothing you didn't already know from the HTTP 200.
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness + database connectivity' })
  @ApiOkResponse({ type: HealthDto })
  check(): Promise<HealthDto> {
    return this.health.check();
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
