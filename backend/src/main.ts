import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      // Query/path params arrive as strings; DTOs declare real types.
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Dev only. The Vite proxy makes everything same-origin in normal use, so this
  // is a safety net for hitting the API directly from a browser tab.
  if (process.env.NODE_ENV !== 'production') {
    app.enableCors({ origin: ['http://localhost:5173'], credentials: true });
  }

  // Makes onModuleDestroy actually fire on Ctrl+C. Without it, Selenium leaks
  // chrome.exe / chromedriver.exe processes on Windows until you reboot.
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('E-Commerce Data Collector')
    .setDescription(
      'Collects product data and price history from Amazon, Etsy and eBay.\n\n' +
        "This spec is the frontend's source of truth: `npm run gen:api` in ../frontend " +
        'generates TypeScript types from /api/docs-json.',
    )
    .setVersion('1.0')
    .addTag('products', 'Collected products and price history')
    .addTag('crawl-jobs', 'Crawl definitions')
    .addTag('crawl-runs', 'Crawl executions')
    .addTag('stats', 'Dashboard counters')
    .addTag('health', 'Liveness')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`API      -> http://localhost:${port}/api`);
  logger.log(`Swagger  -> http://localhost:${port}/api/docs`);
  logger.log(`OpenAPI  -> http://localhost:${port}/api/docs-json`);
}

void bootstrap();
