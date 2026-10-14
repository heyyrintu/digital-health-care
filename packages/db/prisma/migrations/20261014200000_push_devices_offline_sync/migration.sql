-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "AppVariant" AS ENUM ('clinic', 'patient');

-- AlterTable
ALTER TABLE "medicines" ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "app_variant" "AppVariant" NOT NULL,
    "expo_push_token" TEXT NOT NULL,
    "device_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_expo_push_token_key" ON "push_devices"("expo_push_token");

-- CreateIndex
CREATE INDEX "push_devices_session_id_idx" ON "push_devices"("session_id");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "medicines_updated_at_id_idx" ON "medicines"("updated_at", "id");

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Push devices are platform-level like sessions: only the sign-in role reads or writes
-- them (ADR 0014). Clinic queries never see another person's devices.
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON push_devices TO dhc_auth;
CREATE POLICY auth_access ON push_devices TO dhc_auth USING (true) WITH CHECK (true);

ALTER TABLE push_devices ADD CONSTRAINT push_devices_token_format
  CHECK (expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$');
ALTER TABLE push_devices ADD CONSTRAINT push_devices_device_name_length
  CHECK (device_name IS NULL OR char_length(device_name) BETWEEN 1 AND 80);
ALTER TABLE push_devices ADD CONSTRAINT push_devices_revoked
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));

-- A device belongs to the person and clinic of the session it was registered under.
CREATE FUNCTION push_devices_match_session() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND s.user_id = NEW.user_id
      AND s.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'push device must match its session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER push_devices_match_session
  BEFORE INSERT OR UPDATE OF session_id, user_id, organisation_id ON push_devices
  FOR EACH ROW EXECUTE FUNCTION push_devices_match_session();
