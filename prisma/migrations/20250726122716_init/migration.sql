-- CreateEnum
CREATE TYPE "Status" AS ENUM ('approved', 'rejected', 'deleted', 'none');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "youtube_user_id" VARCHAR(30) NOT NULL,
    "email" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "channel_name" VARCHAR(20),
    "profile_image_url" TEXT,
    "channel_intro" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "youtube_channel_id" VARCHAR(40) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Other_channel" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel_id" INTEGER NOT NULL,

    CONSTRAINT "Other_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "video_name" TEXT,
    "video_thumbnail_url" TEXT,
    "upload_date" TIMESTAMP(6),
    "video_type" BOOLEAN,
    "video_link" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video_category" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "video_id" VARCHAR(20) NOT NULL,

    CONSTRAINT "Video_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel_snapshot" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "subscriber" INTEGER,
    "total_videos" INTEGER,
    "total_view" INTEGER,
    "channel_created" TIMESTAMP(6),
    "daily_view" DOUBLE PRECISION,
    "average_view" DOUBLE PRECISION,
    "nation" VARCHAR(2),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video_snapshot" (
    "id" SERIAL NOT NULL,
    "video_id" VARCHAR(20) NOT NULL,
    "view_count" INTEGER,
    "like_count" INTEGER,
    "comment_count" INTEGER,
    "dislike_count" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Video_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" SERIAL NOT NULL,
    "author_name" TEXT,
    "author_id" VARCHAR(30),
    "comment" TEXT,
    "comment_type" INTEGER,
    "comment_date" TIMESTAMP(6),
    "is_parent" BOOLEAN,
    "is_filtered" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "video_id" VARCHAR(20) NOT NULL,
    "youtube_comment_id" TEXT NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment_summary" (
    "id" SERIAL NOT NULL,
    "video_id" VARCHAR(20) NOT NULL,
    "summary" TEXT,
    "positive_ratio" DOUBLE PRECISION,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Other_channel_user_id_channel_id_key" ON "Other_channel"("user_id", "channel_id");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Other_channel" ADD CONSTRAINT "Other_channel_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Other_channel" ADD CONSTRAINT "Other_channel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Video_category" ADD CONSTRAINT "Video_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Video_category" ADD CONSTRAINT "Video_category_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Channel_snapshot" ADD CONSTRAINT "Channel_snapshot_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Video_snapshot" ADD CONSTRAINT "Video_snapshot_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Comment_summary" ADD CONSTRAINT "Comment_summary_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
