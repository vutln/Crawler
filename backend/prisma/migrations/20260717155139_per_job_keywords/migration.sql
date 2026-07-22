-- Per-job keyword selection.
--
-- Additive and non-breaking: trackAllKeywords defaults to true, so every existing
-- sweep keeps collecting the whole keyword list exactly as before, and the new
-- join table starts empty and unread.
--
-- trackAllKeywords is an explicit flag rather than inferring "no rows means all":
-- "collect everything, including keywords added later" and "I have not chosen any
-- keywords yet" are different intentions, and an empty join table cannot tell them
-- apart. Guessing between them is how a job silently collects nothing — or silently
-- collects everything — and nobody finds out until the data is wrong.
ALTER TABLE `CrawlJob` ADD COLUMN `trackAllKeywords` BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE `CrawlJobKeyword` (
    `jobId` VARCHAR(191) NOT NULL,
    `keywordId` VARCHAR(191) NOT NULL,

    INDEX `CrawlJobKeyword_keywordId_idx`(`keywordId`),
    PRIMARY KEY (`jobId`, `keywordId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CrawlJobKeyword` ADD CONSTRAINT `CrawlJobKeyword_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `CrawlJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CrawlJobKeyword` ADD CONSTRAINT `CrawlJobKeyword_keywordId_fkey` FOREIGN KEY (`keywordId`) REFERENCES `Keyword`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
