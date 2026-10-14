-- AlterTable
ALTER TABLE "appointment_status_history" ALTER COLUMN "actor_user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "booking_rules" ADD COLUMN     "no_show_after_minutes" INTEGER DEFAULT 30;

-- CreateIndex
CREATE INDEX "consultations_organisation_id_follow_up_date_idx" ON "consultations"("organisation_id", "follow_up_date");


-- Up to 12 hours after the slot; null switches automatic no-shows off.
ALTER TABLE booking_rules ADD CONSTRAINT booking_rules_no_show_after_minutes
  CHECK (no_show_after_minutes IS NULL OR no_show_after_minutes BETWEEN 0 AND 720);
