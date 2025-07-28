/*
  Warnings:

  - A unique constraint covering the columns `[youtube_comment_id]` on the table `Comment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Comment_youtube_comment_id_key" ON "Comment"("youtube_comment_id");
