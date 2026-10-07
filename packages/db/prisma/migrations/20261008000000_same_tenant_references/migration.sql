-- A tenant row must belong to the same organisation as every tenant row it points at.
-- Foreign key checks do not see row-level security, so without this a tenant-scoped
-- insert for clinic B could still reference clinic A's patient, appointment or clinic by
-- ID. The services always read the parent under RLS first; this is defence in depth, the
-- same rule the prescriptions migration added for prescriptions and their lines.
--
-- One generic function serves every reference. Trigger arguments:
--   TG_ARGV[0]  the referenced table (its key is `id`, its tenant column `organisation_id`)
--   TG_ARGV[1]  the referencing column on the row being written
--   TG_ARGV[2]  optional 'shared': the referenced row may also be platform-wide
--               (organisation_id IS NULL), as for the medicine master
-- A NULL reference is left to the column's own nullability. The lookup compares
-- organisation_id explicitly, so it holds for the owner role too, not only under RLS. The
-- table is schema-qualified with a fixed search_path so a temporary table cannot stand in.
CREATE FUNCTION same_tenant_reference() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ref_table text := TG_ARGV[0];
  ref_column text := TG_ARGV[1];
  allow_shared boolean := TG_NARGS > 2 AND TG_ARGV[2] = 'shared';
  ref_id uuid := to_jsonb(NEW) ->> ref_column;
  ok boolean;
BEGIN
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM public.%I r WHERE r.id = $1 AND (r.organisation_id = $2 OR ($3 AND r.organisation_id IS NULL)))',
    ref_table
  ) INTO ok USING ref_id, NEW.organisation_id, allow_shared;
  IF NOT ok THEN
    RAISE EXCEPTION '%.% does not match a % row in the same organisation',
      TG_TABLE_NAME, ref_column, ref_table USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Patient register.
CREATE TRIGGER patients_guardian_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, guardian_patient_id ON patients
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'guardian_patient_id');
CREATE TRIGGER patient_tags_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON patient_tags
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER patient_tags_tag_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, tag_id ON patient_tags
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('tags', 'tag_id');

-- Scheduling.
CREATE TRIGGER availability_versions_clinic_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, clinic_id ON availability_versions
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('clinics', 'clinic_id');
CREATE TRIGGER availability_versions_type_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, consultation_type_id ON availability_versions
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('consultation_types', 'consultation_type_id');
CREATE TRIGGER availability_exceptions_clinic_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, clinic_id ON availability_exceptions
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('clinics', 'clinic_id');
CREATE TRIGGER availability_exceptions_type_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, consultation_type_id ON availability_exceptions
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('consultation_types', 'consultation_type_id');

-- Appointments and the queue (the queue is appointments by status and token).
CREATE TRIGGER appointments_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER appointments_clinic_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, clinic_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('clinics', 'clinic_id');
CREATE TRIGGER appointments_type_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, consultation_type_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('consultation_types', 'consultation_type_id');
CREATE TRIGGER appointments_rescheduled_from_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, rescheduled_from_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('appointments', 'rescheduled_from_id');
CREATE TRIGGER appointment_status_history_appointment_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id ON appointment_status_history
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('appointments', 'appointment_id');

-- Waiting-room displays.
CREATE TRIGGER display_screens_clinic_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, clinic_id ON display_screens
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('clinics', 'clinic_id');

-- Patient chart.
CREATE TRIGGER allergies_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON allergies
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER medical_conditions_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON medical_conditions
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER current_medications_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON current_medications
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');

-- Consultations. patient_id has no foreign key; it is checked against patients as well.
CREATE TRIGGER vitals_appointment_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id ON vitals
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('appointments', 'appointment_id');
CREATE TRIGGER vitals_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON vitals
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER consultations_appointment_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id ON consultations
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('appointments', 'appointment_id');
CREATE TRIGGER consultations_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON consultations
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');

-- Prescription lines may name a platform medicine or one of the clinic's own, never
-- another clinic's. (Prescriptions and their lines already match by trigger.)
CREATE TRIGGER prescription_items_medicine_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, medicine_id ON prescription_items
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('medicines', 'medicine_id', 'shared');
