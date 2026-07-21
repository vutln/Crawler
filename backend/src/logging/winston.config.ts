import { ConfigService } from '@nestjs/config';
import {
  utilities as nestWinstonModuleUtilities,
  type WinstonModuleOptions,
} from 'nest-winston';
import { basename, isAbsolute, resolve } from 'node:path';
import { format, transports } from 'winston';

export const COMBINED_LOG_FILENAME = 'combined.log';
export const ERROR_LOG_FILENAME = 'error.log';

// During development __dirname is backend/src/logging.
// After compilation it is backend/dist/src/logging.
const COMPILED_OR_BACKEND_ROOT = resolve(__dirname, '..', '..');

const BACKEND_ROOT =
  basename(COMPILED_OR_BACKEND_ROOT).toLowerCase() === 'dist'
    ? resolve(COMPILED_OR_BACKEND_ROOT, '..')
    : COMPILED_OR_BACKEND_ROOT;

function jsonFileFormat() {
  return format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json(),
  );
}

export function resolveLogDirectory(configuredDirectory: string): string {
  return isAbsolute(configuredDirectory)
    ? configuredDirectory
    : resolve(BACKEND_ROOT, configuredDirectory);
}

export function createWinstonOptions(
  config: ConfigService,
): WinstonModuleOptions {
  const level = config.get<string>('LOG_LEVEL', 'info');
  const directory = resolveLogDirectory(config.get<string>('LOG_DIR', 'logs'));
  const maxsize = config.get<number>('LOG_MAX_SIZE', 10_485_760);
  const maxFiles = config.get<number>('LOG_MAX_FILES', 5);
  const production =
    config.get<string>('NODE_ENV', 'development') === 'production';

  return {
    level,
    defaultMeta: {
      service: 'e-commerce-collector',
    },
    transports: [
      new transports.Console({
        level,
        format: format.combine(
          format.timestamp(),
          format.ms(),
          nestWinstonModuleUtilities.format.nestLike('Crawler', {
            colors: !production,
            prettyPrint: true,
          }),
        ),
      }),
      new transports.File({
        dirname: directory,
        filename: COMBINED_LOG_FILENAME,
        level,
        format: jsonFileFormat(),
        maxsize,
        maxFiles,
        tailable: true,
      }),
      new transports.File({
        dirname: directory,
        filename: ERROR_LOG_FILENAME,
        level: 'error',
        format: jsonFileFormat(),
        maxsize,
        maxFiles,
        tailable: true,
      }),
    ],
  };
}
