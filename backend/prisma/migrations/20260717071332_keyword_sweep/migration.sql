-- AlterTable
ALTER TABLE `CrawlJob` MODIFY `type` ENUM('SEARCH', 'PRODUCT_URLS', 'CATEGORY', 'KEYWORD_SWEEP') NOT NULL,
    MODIFY `maxItems` INTEGER NULL;

-- AlterTable
ALTER TABLE `CrawlRun` ADD COLUMN `batchId` VARCHAR(191) NULL,
    ADD COLUMN `keywordId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Keyword` (
    `id` VARCHAR(191) NOT NULL,
    `text` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Keyword_text_key`(`text`),
    INDEX `Keyword_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductKeyword` (
    `productId` VARCHAR(191) NOT NULL,
    `keywordId` VARCHAR(191) NOT NULL,
    `marketplace` ENUM('AMAZON', 'ETSY', 'EBAY') NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastRank` INTEGER NULL,

    INDEX `ProductKeyword_keywordId_marketplace_idx`(`keywordId`, `marketplace`),
    INDEX `ProductKeyword_keywordId_lastRank_idx`(`keywordId`, `lastRank`),
    PRIMARY KEY (`productId`, `keywordId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `CrawlRun_keywordId_createdAt_idx` ON `CrawlRun`(`keywordId`, `createdAt`);

-- CreateIndex
CREATE INDEX `CrawlRun_batchId_idx` ON `CrawlRun`(`batchId`);

-- AddForeignKey
ALTER TABLE `ProductKeyword` ADD CONSTRAINT `ProductKeyword_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductKeyword` ADD CONSTRAINT `ProductKeyword_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `Keyword`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrawlRun` ADD CONSTRAINT `CrawlRun_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `Keyword`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
