-- CreateTable
CREATE TABLE `Product` (
    `id` VARCHAR(191) NOT NULL,
    `marketplace` ENUM('AMAZON', 'ETSY', 'EBAY') NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `url` TEXT NOT NULL,
    `title` TEXT NOT NULL,
    `brand` VARCHAR(191) NULL,
    `seller` VARCHAR(191) NULL,
    `imageUrl` TEXT NULL,
    `currency` CHAR(3) NOT NULL,
    `rating` DECIMAL(3, 2) NULL,
    `reviewCount` INTEGER NULL,
    `categoryId` VARCHAR(191) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastScrapedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `currentPrice` DECIMAL(12, 2) NULL,
    `inStock` BOOLEAN NOT NULL DEFAULT true,
    `snapshotCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `Product_marketplace_lastScrapedAt_idx`(`marketplace`, `lastScrapedAt`),
    INDEX `Product_categoryId_idx`(`categoryId`),
    INDEX `Product_currentPrice_idx`(`currentPrice`),
    INDEX `Product_marketplace_currentPrice_idx`(`marketplace`, `currentPrice`),
    UNIQUE INDEX `Product_marketplace_externalId_key`(`marketplace`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PriceSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `price` DECIMAL(12, 2) NULL,
    `currency` CHAR(3) NOT NULL,
    `inStock` BOOLEAN NOT NULL DEFAULT true,
    `seller` VARCHAR(191) NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `crawlRunId` VARCHAR(191) NULL,

    INDEX `PriceSnapshot_productId_capturedAt_idx`(`productId`, `capturedAt`),
    INDEX `PriceSnapshot_crawlRunId_idx`(`crawlRunId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Category` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(191) NULL,

    INDEX `Category_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrawlJob` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `marketplace` ENUM('AMAZON', 'ETSY', 'EBAY') NOT NULL,
    `type` ENUM('SEARCH', 'PRODUCT_URLS', 'CATEGORY') NOT NULL,
    `query` VARCHAR(191) NULL,
    `urls` JSON NULL,
    `maxPages` INTEGER NOT NULL DEFAULT 3,
    `maxItems` INTEGER NOT NULL DEFAULT 100,
    `cronExpression` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CrawlJob_enabled_cronExpression_idx`(`enabled`, `cronExpression`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrawlRun` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED') NOT NULL DEFAULT 'QUEUED',
    `trigger` ENUM('MANUAL', 'SCHEDULED') NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `itemsFound` INTEGER NOT NULL DEFAULT 0,
    `itemsNew` INTEGER NOT NULL DEFAULT 0,
    `itemsUpdated` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CrawlRun_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `CrawlRun_jobId_createdAt_idx`(`jobId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Product` ADD CONSTRAINT `Product_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PriceSnapshot` ADD CONSTRAINT `PriceSnapshot_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PriceSnapshot` ADD CONSTRAINT `PriceSnapshot_crawlRunId_fkey` FOREIGN KEY (`crawlRunId`) REFERENCES `CrawlRun`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Category` ADD CONSTRAINT `Category_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Category`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrawlRun` ADD CONSTRAINT `CrawlRun_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `CrawlJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
