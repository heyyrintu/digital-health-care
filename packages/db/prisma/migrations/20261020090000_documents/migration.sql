-- Attachments and the clinic document library, part 1 (PRD §7.3: "Send any document to a
-- patient (exercise sheet, diet chart, report) on WhatsApp and in the app; clinic library of
-- reusable sheets"; Build Plan §4, orders module; API guide §3x).
--
-- Three tables:
--
-- * document_files: one stored file each (PDF, JPEG, PNG or WebP), uploaded by a doctor or
--   a clinic admin. The file lives in the private file store (FileStore) by key, never in
--   the database; the row keeps its key, media type, size and SHA-256 and never changes
--   (only `attached_at`, set once when a fresh upload is first used). Files are versions:
--   replacing a library sheet's file uploads a new row and leaves the old one as it was.
-- * library_documents: the clinic's reusable sheets: a title, an optional category, a
--   language and the file it currently points at. Renamed, given a new file, archived and
--   restored; never deleted.
-- * patient_documents: a document shared with a patient (the PRD's Attachment): either a
--   library sheet (`source = library`) or a one-off upload such as a report
--   (`source = upload`), with an optional note to the patient. It keeps its own copy of the
--   title, category and language and points at the exact file row it was shared with, so
--   renaming, replacing or archiving the library sheet later never changes what the
--   patient received. Withdrawing hides it from the patient and keeps the row; it is never
--   deleted.

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('exercise', 'diet', 'information', 'other');

-- CreateEnum
CREATE TYPE "DocumentLanguage" AS ENUM ('en', 'hi', 'other');

-- CreateEnum
CREATE TYPE "PatientDocumentSource" AS ENUM ('library', 'upload');

-- CreateTable
CREATE TABLE "document_files" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_by_role" "Role" NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "attached_at" TIMESTAMPTZ(3),

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_documents" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "DocumentCategory",
    "language" "DocumentLanguage" NOT NULL,
    "file_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "library_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_documents" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID,
    "source" "PatientDocumentSource" NOT NULL,
    "library_document_id" UUID,
    "file_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "DocumentCategory",
    "language" "DocumentLanguage",
    "note" TEXT,
    "shared_by_user_id" UUID NOT NULL,
    "shared_at" TIMESTAMPTZ(3) NOT NULL,
    "opened_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patient_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_files_file_key_key" ON "document_files"("file_key");

-- CreateIndex
CREATE INDEX "library_documents_organisation_id_archived_at_idx" ON "library_documents"("organisation_id", "archived_at");

-- CreateIndex
CREATE INDEX "library_documents_file_id_idx" ON "library_documents"("file_id");

-- CreateIndex
CREATE INDEX "patient_documents_patient_id_idx" ON "patient_documents"("patient_id");

-- CreateIndex
CREATE INDEX "patient_documents_appointment_id_idx" ON "patient_documents"("appointment_id");

-- CreateIndex
CREATE INDEX "patient_documents_library_document_id_idx" ON "patient_documents"("library_document_id");

-- CreateIndex
CREATE INDEX "patient_documents_file_id_idx" ON "patient_documents"("file_id");

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_documents" ADD CONSTRAINT "library_documents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_documents" ADD CONSTRAINT "library_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "document_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_library_document_id_fkey" FOREIGN KEY ("library_document_id") REFERENCES "library_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "document_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Guard rails the API also checks ------------------------------------------------------
-- Files: PDF, JPEG, PNG or WebP only (never SVG, HTML or anything else), with a key inside
-- the organisation's own documents folder whose extension matches the type, so a row can
-- never point at another organisation's files, a test result or a logo.
ALTER TABLE document_files
  ADD CONSTRAINT document_files_file_check
    CHECK (size_bytes > 0 AND sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT document_files_media_type_check
    CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  ADD CONSTRAINT document_files_key_check
    CHECK (file_key ~ ('^organisations/' || organisation_id::text
                       || '/documents/[0-9a-f]{12}\.(pdf|jpg|png|webp)$')
           AND right(file_key, 4) = CASE media_type
             WHEN 'application/pdf' THEN '.pdf'
             WHEN 'image/jpeg' THEN '.jpg'
             WHEN 'image/png' THEN '.png'
             ELSE 'webp' END),
  -- Doctors and clinic admins upload documents; the front desk and patients never do here.
  ADD CONSTRAINT document_files_uploader_role_check
    CHECK (uploaded_by_role IN ('doctor', 'clinic_admin')),
  ADD CONSTRAINT document_files_attached_check
    CHECK (attached_at IS NULL OR attached_at >= uploaded_at);

-- Titles: 1–120 characters, no spaces at either end (the API trims), and no control,
-- bidirectional or invisible characters (as for branding text). Notes: up to 500
-- characters over several lines (line breaks and tabs allowed), not blank.
ALTER TABLE library_documents
  ADD CONSTRAINT library_documents_title_check
    CHECK (length(title) BETWEEN 1 AND 120
           AND btrim(title) = title
           AND title !~ '[\x01-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  ADD CONSTRAINT library_documents_archived_check
    CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL));

ALTER TABLE patient_documents
  ADD CONSTRAINT patient_documents_title_check
    CHECK (length(title) BETWEEN 1 AND 120
           AND btrim(title) = title
           AND title !~ '[\x01-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  ADD CONSTRAINT patient_documents_note_check
    CHECK (note IS NULL OR (length(btrim(note)) >= 1 AND length(note) <= 500
           AND note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]')),
  -- A library share names its sheet; a one-off upload names none.
  ADD CONSTRAINT patient_documents_source_check
    CHECK ((source = 'library') = (library_document_id IS NOT NULL)),
  ADD CONSTRAINT patient_documents_status_check
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by_user_id IS NULL)
           AND (withdrawn_at IS NULL OR withdrawn_at >= shared_at)
           AND (opened_at IS NULL OR opened_at >= shared_at));

-- Row-level security (ADR 0014). Never deleted by the app; files are insert-only apart
-- from `attached_at`.
ALTER TABLE document_files ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON document_files TO dhc_app;
CREATE POLICY tenant_isolation ON document_files TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE library_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON library_documents TO dhc_app;
CREATE POLICY tenant_isolation ON library_documents TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE patient_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON patient_documents TO dhc_app;
CREATE POLICY tenant_isolation ON patient_documents TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Same organisation (foreign keys do not see row-level security) ------------------------
CREATE TRIGGER library_documents_file_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, file_id ON library_documents
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('document_files', 'file_id');
CREATE TRIGGER patient_documents_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER patient_documents_appointment_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('appointments', 'appointment_id');
CREATE TRIGGER patient_documents_library_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, library_document_id ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('library_documents', 'library_document_id');
CREATE TRIGGER patient_documents_file_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, file_id ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('document_files', 'file_id');
-- Nothing new may point at a merged record.
CREATE TRIGGER patient_documents_patient_not_merged
  BEFORE INSERT OR UPDATE OF patient_id ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');

-- Users are platform-level (no organisation of their own): a user named on these rows must
-- hold an active membership of the organisation in a role allowed to do what the row says
-- (each check runs only when that user acts: an insert, or an archiver or withdrawer newly
-- recorded, so a later change of membership never blocks the row's other updates). A
-- share's visit is the patient's own; a library share points at the sheet's file as it
-- is when shared, and only at an active sheet. Tables are schema-qualified with a fixed
-- search_path so a temporary table cannot stand in.
CREATE FUNCTION document_files_checks() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a document file is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = NEW.uploaded_by_user_id
        AND m.organisation_id = NEW.organisation_id
        AND m.status = 'active'
        AND m.role = NEW.uploaded_by_role
    ) THEN
      RAISE EXCEPTION 'document uploader is not a member of its organisation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.attached_at IS NOT NULL THEN
      RAISE EXCEPTION 'a document file starts unattached' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- The stored file never changes (organisation included); a fresh upload is attached once.
  IF (to_jsonb(NEW) - 'attached_at') IS DISTINCT FROM (to_jsonb(OLD) - 'attached_at')
     OR (OLD.attached_at IS NOT NULL AND NEW.attached_at IS DISTINCT FROM OLD.attached_at) THEN
    RAISE EXCEPTION 'a document file cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_files_checks
  BEFORE INSERT OR UPDATE OR DELETE ON document_files
  FOR EACH ROW EXECUTE FUNCTION document_files_checks();

CREATE FUNCTION library_documents_checks() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['title', 'category', 'language', 'file_id',
    'archived_at', 'archived_by_user_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a library document is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = NEW.created_by_user_id
        AND m.organisation_id = NEW.organisation_id
        AND m.status = 'active'
        AND m.role IN ('doctor', 'clinic_admin')
    ) THEN
      RAISE EXCEPTION 'library document creator is not a doctor or clinic admin of its organisation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'a library document starts active' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - changeable) IS DISTINCT FROM (to_jsonb(OLD) - changeable) THEN
    RAISE EXCEPTION 'only a library document''s title, category, language, file and archiving can change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.archived_by_user_id IS NOT NULL
     AND NEW.archived_by_user_id IS DISTINCT FROM OLD.archived_by_user_id
     AND NOT EXISTS (
       SELECT 1 FROM public.memberships m
       WHERE m.user_id = NEW.archived_by_user_id
         AND m.organisation_id = NEW.organisation_id
         AND m.status = 'active'
         AND m.role IN ('doctor', 'clinic_admin')
     ) THEN
    RAISE EXCEPTION 'library document archiver is not a doctor or clinic admin of its organisation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER library_documents_checks
  BEFORE INSERT OR UPDATE OR DELETE ON library_documents
  FOR EACH ROW EXECUTE FUNCTION library_documents_checks();

CREATE FUNCTION patient_documents_checks() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['opened_at', 'withdrawn_at', 'withdrawn_by_user_id',
    'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a shared document is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = NEW.shared_by_user_id
        AND m.organisation_id = NEW.organisation_id
        AND m.status = 'active'
        AND m.role = 'doctor'
    ) THEN
      RAISE EXCEPTION 'document sharer is not a doctor of its organisation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.opened_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a shared document starts unopened and not withdrawn'
        USING ERRCODE = '23514';
    END IF;
    -- The visit is the patient's own (locked FOR SHARE as in same_tenant_reference).
    IF NEW.appointment_id IS NOT NULL THEN
      PERFORM 1 FROM public.appointments a
      WHERE a.id = NEW.appointment_id
        AND a.organisation_id = NEW.organisation_id
        AND a.patient_id = NEW.patient_id
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'shared document does not match its visit' USING ERRCODE = '23514';
      END IF;
      -- Only a visit that took place (checked in or later) or has notes: a booking still to
      -- come moves to the kept record when the patient is merged, which a document pinned
      -- to it (appointments_keep_patient_documents) would stop.
      IF NOT EXISTS (
        SELECT 1 FROM public.appointments a
        WHERE a.id = NEW.appointment_id
          AND (a.status IN ('checked_in', 'in_consultation', 'completed')
               OR EXISTS (SELECT 1 FROM public.consultations c WHERE c.appointment_id = a.id))
      ) THEN
        RAISE EXCEPTION 'a document is shared only at a visit that took place'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    -- A library share points at an active sheet's file as it is now.
    IF NEW.library_document_id IS NOT NULL THEN
      PERFORM 1 FROM public.library_documents l
      WHERE l.id = NEW.library_document_id
        AND l.organisation_id = NEW.organisation_id
        AND l.file_id = NEW.file_id
        AND l.archived_at IS NULL
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'shared document does not match an active library document'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- What was shared never changes: only the patient's first opening and the withdrawal
  -- are recorded, each once.
  IF (to_jsonb(NEW) - changeable) IS DISTINCT FROM (to_jsonb(OLD) - changeable) THEN
    RAISE EXCEPTION 'a shared document cannot change' USING ERRCODE = '23514';
  END IF;
  IF (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)
     OR (OLD.withdrawn_at IS NOT NULL
         AND (NEW.withdrawn_at, NEW.withdrawn_by_user_id)
           IS DISTINCT FROM (OLD.withdrawn_at, OLD.withdrawn_by_user_id)) THEN
    RAISE EXCEPTION 'a shared document''s opening and withdrawal are recorded once'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.withdrawn_by_user_id IS NOT NULL AND OLD.withdrawn_by_user_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.memberships m
       WHERE m.user_id = NEW.withdrawn_by_user_id
         AND m.organisation_id = NEW.organisation_id
         AND m.status = 'active'
         AND m.role = 'doctor'
     ) THEN
    RAISE EXCEPTION 'document withdrawer is not a doctor of its organisation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_documents_checks
  BEFORE INSERT OR UPDATE OR DELETE ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION patient_documents_checks();

-- The other side: a parent with documents keeps its organisation, and a visit with
-- documents keeps its patient.
CREATE TRIGGER patients_keep_patient_documents
  BEFORE UPDATE OF organisation_id ON patients
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('patient_documents', 'patient_id');
CREATE TRIGGER library_documents_keep_children
  BEFORE UPDATE OF organisation_id ON library_documents
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('patient_documents', 'library_document_id');
CREATE FUNCTION appointments_keep_patient_documents() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.organisation_id, NEW.patient_id) IS DISTINCT FROM (OLD.organisation_id, OLD.patient_id)
     AND EXISTS (SELECT 1 FROM public.patient_documents d WHERE d.appointment_id = OLD.id) THEN
    RAISE EXCEPTION 'appointment has shared documents' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_keep_patient_documents
  BEFORE UPDATE OF organisation_id, patient_id
  ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_keep_patient_documents();
-- (document_files never change at all, organisation included: see document_files_checks.)

-- Only these triggers use the functions; no role may call or attach them elsewhere.
REVOKE EXECUTE ON FUNCTION document_files_checks() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION library_documents_checks() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION patient_documents_checks() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION appointments_keep_patient_documents() FROM PUBLIC;
