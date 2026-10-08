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
--
-- The referenced row is locked FOR SHARE until the writing transaction ends. That conflicts
-- with the row lock a concurrent move of the parent takes, so a parent cannot change
-- organisation between this check and the commit: whichever writes second waits, then
-- sees the other's result (a moved parent fails this check; a new child fails the
-- parent's same_tenant_keep_children). The function runs as its owner so it can lock
-- platform rows (shared medicines) that row-level security would not let a clinic lock.
CREATE FUNCTION same_tenant_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ref_table text := TG_ARGV[0];
  ref_column text := TG_ARGV[1];
  allow_shared boolean := TG_NARGS > 2 AND TG_ARGV[2] = 'shared';
  ref_id uuid := to_jsonb(NEW) ->> ref_column;
  hit int;
BEGIN
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT 1 FROM public.%I r WHERE r.id = $1 AND (r.organisation_id = $2 OR ($3 AND r.organisation_id IS NULL)) FOR SHARE',
    ref_table
  ) INTO hit USING ref_id, NEW.organisation_id, allow_shared;
  IF hit IS NULL THEN
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

-- The other side of the same rule: a referenced row keeps its organisation while anything
-- still points at it, so moving a clinic, patient or visit cannot leave its children in
-- the old one. (Like appointments_keep_prescriptions in the prescriptions migration; a row
-- nothing references may still move, where row-level security allows.)
-- Trigger arguments are (child table, child column) pairs that reference this table's id.
CREATE FUNCTION same_tenant_keep_children() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i int := 0;
  found boolean;
BEGIN
  IF NEW.organisation_id IS NOT DISTINCT FROM OLD.organisation_id THEN
    RETURN NEW;
  END IF;
  WHILE i < TG_NARGS LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I c WHERE c.%I = $1)',
      TG_ARGV[i], TG_ARGV[i + 1]) INTO found USING OLD.id;
    IF found THEN
      RAISE EXCEPTION '% row is still referenced by %.%; it keeps its organisation',
        TG_TABLE_NAME, TG_ARGV[i], TG_ARGV[i + 1] USING ERRCODE = '23514';
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER patients_keep_children
  BEFORE UPDATE OF organisation_id ON patients
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children(
    'patients', 'guardian_patient_id', 'patient_tags', 'patient_id',
    'appointments', 'patient_id', 'allergies', 'patient_id',
    'medical_conditions', 'patient_id', 'current_medications', 'patient_id',
    'vitals', 'patient_id', 'consultations', 'patient_id', 'prescriptions', 'patient_id',
    'bills', 'patient_id');
CREATE TRIGGER tags_keep_children
  BEFORE UPDATE OF organisation_id ON tags
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('patient_tags', 'tag_id');
CREATE TRIGGER clinics_keep_children
  BEFORE UPDATE OF organisation_id ON clinics
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children(
    'availability_versions', 'clinic_id', 'availability_exceptions', 'clinic_id',
    'appointments', 'clinic_id', 'display_screens', 'clinic_id');
CREATE TRIGGER consultation_types_keep_children
  BEFORE UPDATE OF organisation_id ON consultation_types
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children(
    'availability_versions', 'consultation_type_id',
    'availability_exceptions', 'consultation_type_id', 'appointments', 'consultation_type_id');
CREATE TRIGGER appointments_keep_children
  BEFORE UPDATE OF organisation_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children(
    'appointments', 'rescheduled_from_id', 'appointment_status_history', 'appointment_id',
    'vitals', 'appointment_id', 'consultations', 'appointment_id');
CREATE TRIGGER medicines_keep_children
  BEFORE UPDATE OF organisation_id ON medicines
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('prescription_items', 'medicine_id');
-- Bills, payments, safety alerts and verifications check their own parents (billing,
-- safety and signing migrations), and a billed or prescribed visit cannot move; a price
-- list entry is the one parent those leave free to move under its bill lines.
CREATE TRIGGER price_list_items_keep_children
  BEFORE UPDATE OF organisation_id ON price_list_items
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('bill_items', 'price_list_item_id');

-- Only the triggers above may run these functions. Creating a trigger needs EXECUTE on its
-- function (firing one does not), so without this a clinic could attach the owner-run
-- check to a temporary table of its own, choose the arguments, and probe other clinics'
-- rows through which inserts fail.
REVOKE EXECUTE ON FUNCTION same_tenant_reference() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION same_tenant_keep_children() FROM PUBLIC;
