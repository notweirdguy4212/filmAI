CREATE TABLE `film_timelines` (
  `id` VARCHAR(191) NOT NULL,
  `productionId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `fps` INTEGER NOT NULL DEFAULT 24,
  `width` INTEGER NOT NULL DEFAULT 1920,
  `height` INTEGER NOT NULL DEFAULT 1080,
  `tracks` JSON NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `film_timelines_productionId_key`(`productionId`),
  INDEX `film_timelines_userId_updatedAt_idx`(`userId`, `updatedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `film_timelines_productionId_fkey` FOREIGN KEY (`productionId`) REFERENCES `film_productions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `film_assets` (
  `id` VARCHAR(191) NOT NULL,
  `productionId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `sourceJobId` VARCHAR(191) NULL,
  `kind` VARCHAR(32) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `mimeType` VARCHAR(128) NOT NULL,
  `storageKey` VARCHAR(1024) NOT NULL,
  `sizeBytes` BIGINT NOT NULL,
  `checksum` VARCHAR(64) NOT NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `film_assets_productionId_kind_createdAt_idx`(`productionId`, `kind`, `createdAt`),
  INDEX `film_assets_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `film_assets_sourceJobId_idx`(`sourceJobId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `film_assets_productionId_fkey` FOREIGN KEY (`productionId`) REFERENCES `film_productions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `film_render_jobs` (
  `id` VARCHAR(191) NOT NULL,
  `productionId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `progress` INTEGER NOT NULL DEFAULT 0,
  `payload` JSON NOT NULL,
  `outputAssetId` VARCHAR(191) NULL,
  `failure` TEXT NULL,
  `attempt` INTEGER NOT NULL DEFAULT 0,
  `startedAt` DATETIME(3) NULL,
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `film_render_jobs_userId_status_createdAt_idx`(`userId`, `status`, `createdAt`),
  INDEX `film_render_jobs_productionId_createdAt_idx`(`productionId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `film_render_jobs_productionId_fkey` FOREIGN KEY (`productionId`) REFERENCES `film_productions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
