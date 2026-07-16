import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer auto-loads .env for the CLI. Node 22 does this natively, so
// we avoid a dotenv dependency that would exist only for the migrate/generate path.
// Guarded: prisma.config.ts is also evaluated in CI, where there is no .env on
// disk and DATABASE_URL arrives as a real environment variable.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // no .env file — fall through to ambient env vars
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  // Used by the CLI (migrate/studio/db push) only. The application itself
  // connects through @prisma/adapter-mariadb — see src/prisma/prisma.service.ts.
  datasource: {
    url: env('DATABASE_URL'),
  },
});
