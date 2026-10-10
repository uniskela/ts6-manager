-- A bot's queued videos. Session options live in AppSetting (video_queue_options:<botId>).
CREATE TABLE "VideoQueueEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "musicBotId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "durationSec" INTEGER,
    "sourceMode" TEXT NOT NULL DEFAULT 'auto',
    "addedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "VideoQueueEntry_musicBotId_position_idx" ON "VideoQueueEntry"("musicBotId", "position");
