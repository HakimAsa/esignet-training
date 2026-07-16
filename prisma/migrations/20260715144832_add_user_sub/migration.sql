-- AlterTable
ALTER TABLE "users" ADD COLUMN     "sub" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_sub_key" ON "users"("sub");

