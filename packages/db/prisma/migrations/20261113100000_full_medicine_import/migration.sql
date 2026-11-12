-- Private full-release ingestion and clinician-entered mapping records only.
-- No changes or grants on prescribing, clinical medicines or safety facts.
CREATE TABLE medicine_import_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dataset_key text NOT NULL,
 source_version text NOT NULL, data_kind text NOT NULL CHECK(data_kind IN ('real','synthetic')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 package_sha256 text NOT NULL CHECK(package_sha256 ~ '^[a-f0-9]{64}$'),
 licence_text_sha256 text NOT NULL CHECK(licence_text_sha256 ~ '^[a-f0-9]{64}$'),
 report jsonb NOT NULL, provenance jsonb NOT NULL,
 brand_count integer NOT NULL CHECK(brand_count BETWEEN 1 AND 200000),
 generic_count integer NOT NULL CHECK(generic_count BETWEEN 1 AND 200000),
 issue_count integer NOT NULL CHECK(issue_count>=0),
 created_by uuid NOT NULL REFERENCES platform_operators(id),
 created_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(dataset_key,source_version)
);
CREATE INDEX medicine_import_releases_created_at_id_idx ON medicine_import_releases(created_at,id);
CREATE TABLE medicine_import_generics (
 release_id uuid NOT NULL REFERENCES medicine_import_releases(id) ON DELETE RESTRICT,
 source_id text NOT NULL CHECK(source_id ~ '^[0-9]{1,18}$'), name text NOT NULL,
 source jsonb NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), mapping jsonb,
 PRIMARY KEY(release_id,source_id),
 CHECK(source #>> '{generic,sourceId}' IS NOT DISTINCT FROM source_id)
);
CREATE TABLE medicine_import_brands (
 release_id uuid NOT NULL REFERENCES medicine_import_releases(id) ON DELETE RESTRICT,
 source_id text NOT NULL CHECK(source_id ~ '^[0-9]{1,18}$'),
 generic_id text NOT NULL, name text NOT NULL, source jsonb NOT NULL,
 PRIMARY KEY(release_id,source_id),
 FOREIGN KEY(release_id,generic_id) REFERENCES medicine_import_generics(release_id,source_id),
 CHECK(source->>'sourceId' IS NOT DISTINCT FROM source_id),
 CHECK(source #>> '{generic,sourceId}' IS NOT DISTINCT FROM generic_id)
);
CREATE INDEX medicine_import_brands_release_id_generic_id_source_id_idx ON medicine_import_brands(release_id,generic_id,source_id);
CREATE TABLE medicine_import_mappings (
 release_id uuid NOT NULL, source_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 mapping jsonb NOT NULL, recorded_by uuid NOT NULL REFERENCES platform_operators(id),
 recorded_at timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY(release_id,source_id,revision),
 FOREIGN KEY(release_id,source_id) REFERENCES medicine_import_generics(release_id,source_id)
);
CREATE TABLE medicine_import_source_rows (
 release_id uuid NOT NULL REFERENCES medicine_import_releases(id),
 file text NOT NULL CHECK(file IN ('BrandMaster.txt','GenericMaster.txt','SubstanceMaster.txt','ProductMaster.txt','SupplierMaster.txt','DrugFormMaster.txt','RouteOfAdministrationMaster.txt')),
 source_id text NOT NULL CHECK(source_id ~ '^[0-9]{1,18}$'), name text NOT NULL, "values" jsonb NOT NULL,
 PRIMARY KEY(release_id,file,source_id)
);
ALTER TABLE medicine_import_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_generics ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_generics FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_brands FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_source_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicine_import_source_rows FORCE ROW LEVEL SECURITY;
GRANT SELECT ON medicine_import_releases,medicine_import_generics,medicine_import_brands,medicine_import_mappings,medicine_import_source_rows TO dhc_platform;
GRANT UPDATE(revision,mapping) ON medicine_import_generics TO dhc_platform;
GRANT INSERT ON medicine_import_mappings TO dhc_platform;
CREATE POLICY medicine_import_release_operator ON medicine_import_releases TO dhc_platform USING(true);
CREATE POLICY medicine_import_generic_operator ON medicine_import_generics TO dhc_platform USING(true) WITH CHECK(true);
CREATE POLICY medicine_import_brand_operator ON medicine_import_brands TO dhc_platform USING(true);
CREATE POLICY medicine_import_mapping_operator ON medicine_import_mappings TO dhc_platform USING(true) WITH CHECK(true);
CREATE POLICY medicine_import_source_operator ON medicine_import_source_rows TO dhc_platform USING(true);

CREATE FUNCTION guard_import_generic_mapping() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.release_id IS DISTINCT FROM OLD.release_id OR NEW.source_id IS DISTINCT FROM OLD.source_id
 OR NEW.name IS DISTINCT FROM OLD.name OR NEW.source IS DISTINCT FROM OLD.source THEN
  RAISE EXCEPTION 'Imported source records are immutable'; END IF;
 IF NEW.revision<>OLD.revision+1 OR NEW.mapping IS NULL THEN
  RAISE EXCEPTION 'Invalid clinical mapping revision'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_import_generic_mapping() FROM PUBLIC;
CREATE TRIGGER medicine_import_generic_guard BEFORE UPDATE ON medicine_import_generics
 FOR EACH ROW EXECUTE FUNCTION guard_import_generic_mapping();
