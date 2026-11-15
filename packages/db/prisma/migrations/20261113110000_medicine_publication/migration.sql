ALTER TABLE medicines ADD COLUMN catalogue_revision integer CHECK(catalogue_revision>0);
ALTER TABLE prescription_items ADD COLUMN catalogue_revision integer CHECK(catalogue_revision>0);
CREATE TABLE medicine_catalogue_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('licence','clinical','safety')),
 scope_key text NOT NULL, document_sha256 text NOT NULL CHECK(document_sha256 ~ '^[a-f0-9]{64}$'),
 file_key text NOT NULL, details jsonb NOT NULL, valid_from timestamptz(3) NOT NULL,
 valid_until timestamptz(3), recorded_by uuid NOT NULL REFERENCES platform_operators(id),
 recorded_at timestamptz(3) NOT NULL DEFAULT now(), revoked_at timestamptz(3), revoked_reason text,
 CHECK(valid_until IS NULL OR valid_until>valid_from),
 CHECK((revoked_at IS NULL)=(revoked_reason IS NULL))
);
CREATE INDEX medicine_catalogue_evidence_kind_scope_key_idx ON medicine_catalogue_evidence(kind,scope_key);
CREATE TABLE medicine_catalogue_publications (
 dataset_key text NOT NULL, brand_source_id text NOT NULL, release_id uuid NOT NULL,
 medicine_id uuid NOT NULL UNIQUE REFERENCES medicines(id), revision integer NOT NULL CHECK(revision>0),
 mapping_revision integer NOT NULL CHECK(mapping_revision>0), entry_hash text NOT NULL CHECK(entry_hash ~ '^[a-f0-9]{64}$'),
 licence_id uuid NOT NULL REFERENCES medicine_catalogue_evidence(id),
 clinical_id uuid NOT NULL REFERENCES medicine_catalogue_evidence(id),
 safety_id uuid NOT NULL REFERENCES medicine_catalogue_evidence(id),
 published_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY(dataset_key,brand_source_id),
 FOREIGN KEY(release_id,brand_source_id) REFERENCES medicine_import_brands(release_id,source_id)
);
CREATE TABLE medicine_catalogue_publication_events (
 medicine_id uuid NOT NULL REFERENCES medicine_catalogue_publications(medicine_id),
 revision integer NOT NULL CHECK(revision>0), snapshot jsonb NOT NULL,
 recorded_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY(medicine_id,revision)
);
ALTER TABLE medicine_catalogue_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_catalogue_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_catalogue_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_catalogue_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_catalogue_publication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_catalogue_publication_events FORCE ROW LEVEL SECURITY;
GRANT SELECT ON medicine_catalogue_evidence,medicine_catalogue_publications,medicine_catalogue_publication_events TO dhc_platform;
CREATE POLICY catalogue_evidence_operator ON medicine_catalogue_evidence TO dhc_platform USING(true);
CREATE POLICY catalogue_publication_operator ON medicine_catalogue_publications TO dhc_platform USING(true);
CREATE POLICY catalogue_event_operator ON medicine_catalogue_publication_events TO dhc_platform USING(true);

CREATE FUNCTION guard_catalogue_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR length(btrim(NEW.revoked_reason))<10
 OR (to_jsonb(NEW)-'revoked_at'-'revoked_reason') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_reason') THEN
 RAISE EXCEPTION 'Evidence is immutable; only a documented one-way revocation is permitted'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_catalogue_evidence() FROM PUBLIC;
CREATE TRIGGER catalogue_evidence_guard BEFORE UPDATE ON medicine_catalogue_evidence
 FOR EACH ROW EXECUTE FUNCTION guard_catalogue_evidence();

-- Only public reference ingredient identities, never patient/clinic data or safety claims.
CREATE FUNCTION platform_reference_molecules(query text) RETURNS TABLE(id uuid,name text,"drugClass" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT m.id,m.name,m.drug_class FROM public.drug_molecules m
 WHERE length(btrim(query)) BETWEEN 2 AND 60 AND
 (position(lower(query) IN lower(m.name))>0 OR position(lower(query) IN lower(coalesce(m.drug_class,'')))>0)
 ORDER BY m.name,m.id LIMIT 20;
$$;
CREATE FUNCTION platform_reference_molecule_ids(ids uuid[]) RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT m.id,m.name FROM public.drug_molecules m WHERE cardinality(ids)<=100 AND m.id=ANY(ids);
$$;
CREATE FUNCTION platform_reference_version() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT version FROM public.drug_database WHERE id=1;
$$;
REVOKE ALL ON FUNCTION platform_reference_molecules(text),platform_reference_molecule_ids(uuid[]),platform_reference_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_reference_molecules(text),platform_reference_molecule_ids(uuid[]),platform_reference_version() TO dhc_platform;

-- Narrow clinic predicate. It exposes no approval documents or other clinics' medicines.
CREATE FUNCTION catalogue_medicine_eligible(medicine_uuid uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT (m.catalogue_revision IS NULL AND (m.source='clinic' OR NOT EXISTS(SELECT 1 FROM public.medicine_catalogue_publications))) OR (
  p.revision=m.catalogue_revision AND l.kind='licence' AND l.scope_key=p.dataset_key
  AND l.details->>'territory'='IN' AND l.details->>'useWithinIndiaConfirmed'='true'
  AND s.kind='safety' AND s.scope_key=(SELECT version FROM public.drug_database WHERE id=1)
  AND c.kind='clinical' AND c.details->>'releaseId'=p.release_id::text
  AND c.details->>'sourceId'=b.generic_id
  AND c.details->>'brandRegulatoryReviewConfirmed'='true' AND (c.details->'brandHashes') ? p.brand_source_id
  AND c.details->>'revision'=p.mapping_revision::text
  AND l.revoked_at IS NULL AND s.revoked_at IS NULL AND c.revoked_at IS NULL
  AND l.valid_from<=clock_timestamp() AND s.valid_from<=clock_timestamp() AND c.valid_from<=clock_timestamp()
  AND (l.valid_until IS NULL OR l.valid_until>clock_timestamp())
  AND (s.valid_until IS NULL OR s.valid_until>clock_timestamp())
  AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())
  AND EXISTS(SELECT 1 FROM public.doctor_profiles d WHERE d.id::text=c.details->>'doctorProfileId'
   AND d.verification='verified' AND d.registration_number=c.details->>'registrationNumber' AND d.council=c.details->>'council')
  AND EXISTS(SELECT 1 FROM public.doctor_profiles d WHERE d.id::text=s.details->>'doctorProfileId'
   AND d.verification='verified' AND d.registration_number=s.details->>'registrationNumber' AND d.council=s.details->>'council')
 ) FROM public.medicines m
 LEFT JOIN public.medicine_catalogue_publications p ON p.medicine_id=m.id
 LEFT JOIN public.medicine_import_brands b ON b.release_id=p.release_id AND b.source_id=p.brand_source_id
 LEFT JOIN public.medicine_catalogue_evidence l ON l.id=p.licence_id
 LEFT JOIN public.medicine_catalogue_evidence s ON s.id=p.safety_id
 LEFT JOIN public.medicine_catalogue_evidence c ON c.id=p.clinical_id
 WHERE m.id=medicine_uuid AND (m.organisation_id IS NULL OR
 m.organisation_id::text=current_setting('app.organisation_id',true))),false);
$$;
REVOKE ALL ON FUNCTION catalogue_medicine_eligible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalogue_medicine_eligible(uuid) TO dhc_app;

-- Facts changing under the same version must not keep their old approval alive.
CREATE FUNCTION invalidate_catalogue_safety() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('clinical-medicine-catalogue',0));
 UPDATE public.medicine_catalogue_evidence SET revoked_at=clock_timestamp(),
 revoked_reason='Reference safety facts changed; a new clinical approval is required'
 WHERE kind='safety' AND revoked_at IS NULL;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION invalidate_catalogue_safety() FROM PUBLIC;
CREATE TRIGGER catalogue_molecule_facts AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON drug_molecules FOR EACH STATEMENT EXECUTE FUNCTION invalidate_catalogue_safety();
CREATE TRIGGER catalogue_interaction_facts AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON drug_interactions FOR EACH STATEMENT EXECUTE FUNCTION invalidate_catalogue_safety();
CREATE TRIGGER catalogue_condition_facts AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON drug_condition_rules FOR EACH STATEMENT EXECUTE FUNCTION invalidate_catalogue_safety();
CREATE TRIGGER catalogue_cross_facts AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON drug_cross_sensitivities FOR EACH STATEMENT EXECUTE FUNCTION invalidate_catalogue_safety();
CREATE TRIGGER catalogue_database_facts AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON drug_database FOR EACH STATEMENT EXECUTE FUNCTION invalidate_catalogue_safety();

-- Backends predating the catalogue revision cannot bypass the new contract on rollback.
CREATE FUNCTION guard_catalogue_prescription_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ DECLARE current_revision integer; BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('clinical-medicine-catalogue',0));
 SELECT catalogue_revision INTO current_revision FROM public.medicines WHERE id=NEW.medicine_id;
 IF current_revision IS NOT NULL OR EXISTS(SELECT 1 FROM public.medicines WHERE id=NEW.medicine_id AND source='reference') THEN
  IF NEW.catalogue_revision IS DISTINCT FROM current_revision OR NOT public.catalogue_medicine_eligible(NEW.medicine_id) THEN
   -- Preserve an exact historical line when starting an amendment, so the doctor
   -- can remove/reselect it. It remains ineligible for saving/signing as current.
   IF NOT EXISTS(SELECT 1 FROM public.prescriptions p JOIN public.prescription_items i ON i.prescription_id=p.amends_prescription_id
    WHERE p.id=NEW.prescription_id AND (to_jsonb(i)-'id'-'prescription_id') IS NOT DISTINCT FROM (to_jsonb(NEW)-'id'-'prescription_id')) THEN
    RAISE EXCEPTION 'Medicine catalogue changed or approval is unavailable; reselect the medicine'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_catalogue_prescription_item() FROM PUBLIC;
CREATE TRIGGER catalogue_prescription_item_guard BEFORE INSERT OR UPDATE ON prescription_items FOR EACH ROW EXECUTE FUNCTION guard_catalogue_prescription_item();
CREATE FUNCTION guard_catalogue_signature() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NEW.status='signed' AND OLD.status='draft' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('clinical-medicine-catalogue',0));
  IF EXISTS(SELECT 1 FROM public.prescription_items i JOIN public.medicines m ON m.id=i.medicine_id
   WHERE i.prescription_id=NEW.id AND (m.catalogue_revision IS NOT NULL OR m.source='reference')
   AND (i.catalogue_revision IS DISTINCT FROM m.catalogue_revision OR NOT m.active OR NOT public.catalogue_medicine_eligible(m.id))) THEN
   RAISE EXCEPTION 'Medicine catalogue changed or approval is unavailable; review the draft again'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_catalogue_signature() FROM PUBLIC;
CREATE TRIGGER catalogue_signature_guard BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION guard_catalogue_signature();
