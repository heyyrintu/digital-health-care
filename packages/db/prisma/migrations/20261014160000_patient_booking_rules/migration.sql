-- Patient self-booking rules (PRD §4.3), with the PRD defaults.
ALTER TABLE "booking_rules" ADD COLUMN "max_active_bookings" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "no_show_limit" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "no_show_window_days" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN "cancel_cutoff_minutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN "auto_confirm" BOOLEAN NOT NULL DEFAULT true;
