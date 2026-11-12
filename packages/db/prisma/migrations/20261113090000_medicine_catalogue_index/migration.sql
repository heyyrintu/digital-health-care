-- Relational source index, not the prescribing master. Clinical tables and grants
-- are unchanged. The synthetic-only stage constraints remain in force.
CREATE TABLE platform_medicine_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 dataset_key text NOT NULL CHECK (length(dataset_key) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK (kind IN ('brand','product','supplier','generic','ingredient','form','route')),
 source_id text NOT NULL CHECK (source_id ~ '^[0-9]{1,18}$'),
 CONSTRAINT platform_medicine_identity_source_key UNIQUE(dataset_key,kind,source_id)
);
CREATE TABLE platform_medicine_entities (
 stage_id uuid NOT NULL REFERENCES platform_medicine_stages(id) ON DELETE CASCADE,
 identity_id uuid NOT NULL REFERENCES platform_medicine_identities(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK (length(btrim(name)) > 0),
 PRIMARY KEY(stage_id,identity_id)
);
CREATE INDEX platform_medicine_entities_identity_id_stage_id_idx ON platform_medicine_entities(identity_id,stage_id);
CREATE TABLE platform_medicine_links (
 stage_id uuid NOT NULL, from_id uuid NOT NULL, to_id uuid NOT NULL,
 PRIMARY KEY(stage_id,from_id,to_id), CHECK (from_id<>to_id),
 FOREIGN KEY(stage_id,from_id) REFERENCES platform_medicine_entities(stage_id,identity_id) ON DELETE CASCADE,
 FOREIGN KEY(stage_id,to_id) REFERENCES platform_medicine_entities(stage_id,identity_id) ON DELETE CASCADE
);
CREATE INDEX platform_medicine_links_stage_id_to_id_idx ON platform_medicine_links(stage_id,to_id);

ALTER TABLE platform_medicine_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_medicine_links FORCE ROW LEVEL SECURITY;
GRANT SELECT ON platform_medicine_identities,platform_medicine_entities,platform_medicine_links TO dhc_platform;
CREATE POLICY medicine_identity_operator ON platform_medicine_identities TO dhc_platform USING (true);
CREATE POLICY medicine_entity_operator ON platform_medicine_entities TO dhc_platform USING (true);
CREATE POLICY medicine_link_operator ON platform_medicine_links TO dhc_platform USING (true);

-- The migration owner is the only writer. Platform operators cannot insert, alter
-- or delete index rows; the index is derived atomically from the immutable bundle.
CREATE FUNCTION index_platform_medicine_stage(stage_uuid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stage public.platform_medicine_stages%ROWTYPE; nodes jsonb;
BEGIN
 SELECT * INTO STRICT stage FROM public.platform_medicine_stages WHERE id=stage_uuid;
 IF stage.bundle #>> '{catalogue,source,dataKind}' IS DISTINCT FROM 'synthetic' THEN
  RAISE EXCEPTION 'Only synthetic snapshots may be indexed before licensing';
 END IF;
 -- A source identity may have different names across releases. Within a release,
 -- conflicting names fail the unique entity key rather than silently overwriting.
 SELECT jsonb_agg(DISTINCT n) INTO nodes
 FROM jsonb_array_elements(stage.bundle #> '{catalogue,records}') r
 CROSS JOIN LATERAL (
  SELECT jsonb_build_object('kind','brand','sourceId',r->>'sourceId','name',r->>'name') n
  UNION ALL SELECT (r->'product') || '{"kind":"product"}'::jsonb
  UNION ALL SELECT (r->'supplier') || '{"kind":"supplier"}'::jsonb
  UNION ALL SELECT (r->'generic') || '{"kind":"generic"}'::jsonb
  UNION ALL SELECT (r->'form') || '{"kind":"form"}'::jsonb
  UNION ALL SELECT i || '{"kind":"ingredient"}'::jsonb FROM jsonb_array_elements(r->'ingredients') i
  UNION ALL SELECT t || '{"kind":"route"}'::jsonb FROM jsonb_array_elements(r->'routes') t
 ) refs;

 INSERT INTO public.platform_medicine_identities(dataset_key,kind,source_id)
 SELECT DISTINCT stage.dataset_key,n->>'kind',n->>'sourceId' FROM jsonb_array_elements(nodes) n
 -- Consistent ordering prevents reversed acquisition of shared identity locks
 -- when two versions of a dataset arrive concurrently.
 ORDER BY 1,2,3 ON CONFLICT(dataset_key,kind,source_id) DO NOTHING;

 INSERT INTO public.platform_medicine_entities(stage_id,identity_id,name)
 SELECT stage.id,i.id,n->>'name' FROM jsonb_array_elements(nodes) n
 JOIN public.platform_medicine_identities i ON i.dataset_key=stage.dataset_key
 AND i.kind=n->>'kind' AND i.source_id=n->>'sourceId';

 INSERT INTO public.platform_medicine_links(stage_id,from_id,to_id)
 SELECT DISTINCT stage.id,b.id,t.id
 FROM jsonb_array_elements(stage.bundle #> '{catalogue,records}') r
 JOIN public.platform_medicine_identities b ON b.dataset_key=stage.dataset_key
 AND b.kind='brand' AND b.source_id=r->>'sourceId'
 CROSS JOIN LATERAL (
  SELECT 'product' kind,r->'product' ref
  UNION ALL SELECT 'supplier',r->'supplier'
  UNION ALL SELECT 'generic',r->'generic'
  UNION ALL SELECT 'form',r->'form'
  UNION ALL SELECT 'ingredient',i FROM jsonb_array_elements(r->'ingredients') i
  UNION ALL SELECT 'route',t FROM jsonb_array_elements(r->'routes') t
 ) refs
 JOIN public.platform_medicine_identities t ON t.dataset_key=stage.dataset_key
 AND t.kind=refs.kind AND t.source_id=refs.ref->>'sourceId';
END $$;
REVOKE ALL ON FUNCTION index_platform_medicine_stage(uuid) FROM PUBLIC;

CREATE FUNCTION index_new_platform_medicine_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM public.index_platform_medicine_stage(NEW.id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION index_new_platform_medicine_stage() FROM PUBLIC;
CREATE TRIGGER platform_medicine_stage_index AFTER INSERT ON platform_medicine_stages
 FOR EACH ROW EXECUTE FUNCTION index_new_platform_medicine_stage();

-- Include snapshots that predate this migration, without changing their bytes,
-- review decision, revision or active sandbox selection.
SELECT public.index_platform_medicine_stage(id) FROM public.platform_medicine_stages ORDER BY id;
