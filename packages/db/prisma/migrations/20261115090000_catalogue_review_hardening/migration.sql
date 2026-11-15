-- Bind stable identities to the actual source dataset, not merely a valid brand ID.
ALTER TABLE medicine_import_releases ADD CONSTRAINT medicine_import_releases_id_dataset_key_key UNIQUE(id,dataset_key);
ALTER TABLE medicine_catalogue_publications ADD CONSTRAINT medicine_catalogue_publications_release_dataset_fkey
 FOREIGN KEY(release_id,dataset_key) REFERENCES medicine_import_releases(id,dataset_key) ON DELETE RESTRICT;
-- Review-state filtering precedes cursor pagination; retain early LIMIT termination.
CREATE INDEX medicine_import_generics_untouched_idx ON medicine_import_generics(release_id,source_id) WHERE mapping IS NULL;
CREATE INDEX medicine_import_generics_decision_idx ON medicine_import_generics(release_id,(mapping #> '{decision}'),source_id);

CREATE OR REPLACE FUNCTION catalogue_medicine_eligible(medicine_uuid uuid) RETURNS boolean
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
  AND EXISTS(SELECT 1 FROM public.doctor_profiles d JOIN public.users u ON u.id=d.user_id AND u.status='active' WHERE d.id::text=c.details->>'doctorProfileId'
   AND d.verification='verified' AND d.registration_number=c.details->>'registrationNumber' AND d.council=c.details->>'council')
  AND EXISTS(SELECT 1 FROM public.doctor_profiles d JOIN public.users u ON u.id=d.user_id AND u.status='active' WHERE d.id::text=s.details->>'doctorProfileId'
   AND d.verification='verified' AND d.registration_number=s.details->>'registrationNumber' AND d.council=s.details->>'council')
 ) FROM public.medicines m
 LEFT JOIN public.medicine_catalogue_publications p ON p.medicine_id=m.id
 LEFT JOIN public.medicine_import_brands b ON b.release_id=p.release_id AND b.source_id=p.brand_source_id
 LEFT JOIN public.medicine_catalogue_evidence l ON l.id=p.licence_id
 LEFT JOIN public.medicine_catalogue_evidence s ON s.id=p.safety_id
 LEFT JOIN public.medicine_catalogue_evidence c ON c.id=p.clinical_id
 WHERE m.id=medicine_uuid AND m.active AND (m.organisation_id IS NULL OR
 m.organisation_id::text=current_setting('app.organisation_id',true))),false);
$$;
REVOKE ALL ON FUNCTION catalogue_medicine_eligible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalogue_medicine_eligible(uuid) TO dhc_app;
