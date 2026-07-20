-- AlterTable
ALTER TABLE "users" DROP COLUMN "picture",
ADD COLUMN     "profile" JSONB;

