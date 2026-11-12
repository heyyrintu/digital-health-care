-- Isolated operator sandbox only. No grants on medicines, prescriptions or clinical data.
CREATE TABLE platform_medicine_stages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dataset_key text NOT NULL, source_version text NOT NULL,
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'), bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[a-f0-9]{64}$'),
 bundle jsonb NOT NULL, candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 1 AND 500),
 issue_count integer NOT NULL CHECK (issue_count BETWEEN 0 AND 2000),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','reviewed','rejected','published_demo')),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_by uuid NOT NULL REFERENCES platform_operators(id), created_at timestamptz(3) NOT NULL DEFAULT now(),
 reviewed_by uuid REFERENCES platform_operators(id), reviewed_at timestamptz(3), review_note text,
 UNIQUE(dataset_key,source_version),
 CHECK ((bundle #>> '{catalogue,source,dataKind}') IS NOT DISTINCT FROM 'synthetic'),
 CHECK ((bundle #>> '{catalogue,source,datasetKey}') IS NOT DISTINCT FROM dataset_key),
 CHECK ((bundle #>> '{catalogue,source,version}') IS NOT DISTINCT FROM source_version),
 CHECK ((bundle #>> '{catalogue,fingerprint}') IS NOT DISTINCT FROM fingerprint),
 CHECK ((bundle #> '{catalogue,publicationAllowed}') IS NOT DISTINCT FROM 'false'::jsonb),
 CHECK ((state='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
 OR (state<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL AND length(btrim(review_note)) BETWEEN 10 AND 1000))
);
CREATE INDEX platform_medicine_stage_page ON platform_medicine_stages(created_at DESC,id DESC);
CREATE TABLE platform_medicine_sandbox (
 id smallint PRIMARY KEY CHECK (id=1), stage_id uuid NOT NULL UNIQUE REFERENCES platform_medicine_stages(id),
 updated_by uuid NOT NULL REFERENCES platform_operators(id), updated_at timestamptz(3) NOT NULL
);
ALTER TABLE platform_medicine_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_stages FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_sandbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_sandbox FORCE ROW LEVEL SECURITY;
GRANT SELECT ON platform_medicine_stages,platform_medicine_sandbox TO dhc_platform;
GRANT INSERT(id,dataset_key,source_version,fingerprint,bundle_hash,bundle,candidate_count,issue_count,created_by,created_at) ON platform_medicine_stages TO dhc_platform;
GRANT UPDATE(state,revision,reviewed_by,reviewed_at,review_note) ON platform_medicine_stages TO dhc_platform;
GRANT INSERT, UPDATE ON platform_medicine_sandbox TO dhc_platform;
CREATE POLICY medicine_stage_operator ON platform_medicine_stages TO dhc_platform USING (true) WITH CHECK (true);
CREATE POLICY medicine_sandbox_operator ON platform_medicine_sandbox TO dhc_platform USING (true) WITH CHECK (true);
CREATE FUNCTION guard_medicine_stage_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.bundle IS DISTINCT FROM OLD.bundle OR NEW.bundle_hash IS DISTINCT FROM OLD.bundle_hash
 OR NEW.dataset_key IS DISTINCT FROM OLD.dataset_key OR NEW.source_version IS DISTINCT FROM OLD.source_version
 OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR NEW.created_by IS DISTINCT FROM OLD.created_by
 OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.candidate_count IS DISTINCT FROM OLD.candidate_count
 OR NEW.issue_count IS DISTINCT FROM OLD.issue_count THEN RAISE EXCEPTION 'Staged snapshots are immutable'; END IF;
 IF NOT ((OLD.state='pending' AND NEW.state IN ('reviewed','rejected'))
 OR (OLD.state IN ('reviewed','published_demo') AND NEW.state='published_demo')) THEN
  RAISE EXCEPTION 'Invalid medicine review transition';
 END IF;
 IF OLD.state<>'pending' AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
 OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_note IS DISTINCT FROM OLD.review_note) THEN
  RAISE EXCEPTION 'Review decisions are immutable';
 END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid medicine stage revision'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_medicine_stage_guard BEFORE UPDATE ON platform_medicine_stages
 FOR EACH ROW EXECUTE FUNCTION guard_medicine_stage_transition();

REVOKE ALL ON FUNCTION guard_medicine_stage_transition() FROM PUBLIC;
