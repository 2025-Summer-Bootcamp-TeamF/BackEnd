-- CreateEnum
CREATE TYPE "public"."Status" AS ENUM ('approved', 'rejected', 'deleted', 'none');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" SERIAL NOT NULL,
    "youtube_user_id" VARCHAR(30) NOT NULL,
    "email" TEXT NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Category" (
    "id" SERIAL NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Channel" (
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
CREATE TABLE "public"."Other_channel" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel_id" INTEGER NOT NULL,

    CONSTRAINT "Other_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Video" (
    "id" TEXT NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "video_name" TEXT,
    "video_thumbnail_url" TEXT,
    "upload_date" TIMESTAMP(6),
    "video_type" BOOLEAN,
    "video_link" TEXT,
    "duration" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment_classified_at" TIMESTAMP(6) DEFAULT '2000-01-01 00:00:00'::timestamp without time zone,
    "filtering_keyword" VARCHAR(255),

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Video_category" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "video_id" VARCHAR(20) NOT NULL,

    CONSTRAINT "Video_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Channel_snapshot" (
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
CREATE TABLE "public"."Video_snapshot" (
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
CREATE TABLE "public"."Comment" (
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
CREATE TABLE "public"."Comment_summary" (
    "id" SERIAL NOT NULL,
    "video_id" VARCHAR(20) NOT NULL,
    "summary" TEXT,
    "summary_title" TEXT,
    "positive_ratio" DOUBLE PRECISION,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Other_channel_user_id_channel_id_key" ON "public"."Other_channel"("user_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_youtube_comment_id_key" ON "public"."Comment"("youtube_comment_id");

-- AddForeignKey
ALTER TABLE "public"."Channel" ADD CONSTRAINT "Channel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Other_channel" ADD CONSTRAINT "Other_channel_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."Channel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Other_channel" ADD CONSTRAINT "Other_channel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Video" ADD CONSTRAINT "Video_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."Channel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Video_category" ADD CONSTRAINT "Video_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."Category"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Video_category" ADD CONSTRAINT "Video_category_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "public"."Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Channel_snapshot" ADD CONSTRAINT "Channel_snapshot_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."Channel"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Video_snapshot" ADD CONSTRAINT "Video_snapshot_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "public"."Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "public"."Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."Comment_summary" ADD CONSTRAINT "Comment_summary_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "public"."Video"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
