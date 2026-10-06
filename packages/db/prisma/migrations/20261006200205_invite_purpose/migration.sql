-- CreateEnum
CREATE TYPE "InvitePurpose" AS ENUM ('join', 'reset');

-- AlterTable
ALTER TABLE "staff_invites" ADD COLUMN     "purpose" "InvitePurpose" NOT NULL DEFAULT 'join';
