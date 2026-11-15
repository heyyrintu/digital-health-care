-- Supports early LIMIT termination in the approval-filtered prescribing search.
CREATE INDEX medicines_name_id_idx ON medicines(name,id);

-- Deferred checks permit the owner's atomic medicine/ingredient/event batch but
-- reject direct hotfixes that bypass review or omit the matching revision/event.
CREATE FUNCTION guard_published_catalogue_recipe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE medicine_uuid uuid; m public.medicines%ROWTYPE; published_revision integer; snapshot jsonb;
BEGIN
 IF TG_TABLE_NAME='medicines' THEN
  IF TG_OP='DELETE' THEN medicine_uuid=OLD.id; ELSE medicine_uuid=NEW.id; END IF;
 ELSE
  IF TG_OP='DELETE' THEN medicine_uuid=OLD.medicine_id; ELSE medicine_uuid=NEW.medicine_id; END IF;
 END IF;
 SELECT * INTO m FROM public.medicines WHERE id=medicine_uuid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT p.revision,e.snapshot INTO published_revision,snapshot
 FROM public.medicine_catalogue_publications p
 LEFT JOIN public.medicine_catalogue_publication_events e ON e.medicine_id=p.medicine_id AND e.revision=p.revision
 WHERE p.medicine_id=medicine_uuid;
 IF m.catalogue_revision IS NULL AND published_revision IS NULL THEN RETURN NULL; END IF;
 IF m.catalogue_revision IS DISTINCT FROM published_revision OR snapshot IS NULL
 OR m.organisation_id IS NOT NULL OR m.source<>'reference' THEN
  RAISE EXCEPTION 'Published catalogue medicine needs its matching revision and review event'; END IF;
 IF snapshot->>'withdrawn'='true' THEN
  IF m.active THEN RAISE EXCEPTION 'Withdrawn catalogue medicine cannot be activated without new publication'; END IF;
  RETURN NULL;
 END IF;
 IF NOT m.active OR snapshot->>'name' IS DISTINCT FROM m.name
 OR snapshot->>'genericName' IS DISTINCT FROM m.generic_name
 OR snapshot->>'composition' IS DISTINCT FROM m.composition
 OR snapshot->>'form' IS DISTINCT FROM m.form
 OR snapshot->>'defaultRoute' IS DISTINCT FROM m.default_route::text
 OR snapshot->>'catalogueRevision' IS DISTINCT FROM m.catalogue_revision::text THEN
  RAISE EXCEPTION 'Published catalogue medicine no longer matches its reviewed snapshot'; END IF;
 IF jsonb_array_length(snapshot #> '{mapping,ingredients}') IS DISTINCT FROM
  (SELECT count(*)::integer FROM public.medicine_ingredients WHERE medicine_id=medicine_uuid)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot #> '{mapping,ingredients}') s
  WHERE NOT EXISTS(SELECT 1 FROM public.medicine_ingredients i WHERE i.medicine_id=medicine_uuid
   AND i.molecule_id::text=s->>'moleculeId' AND i.per::text=s->>'per'
   AND i.strength_mg=(s->>'value')::numeric * CASE s->>'unit' WHEN 'mg' THEN 1::numeric
    WHEN 'g' THEN 1000::numeric WHEN 'microgram' THEN 0.001::numeric ELSE NULL END)) THEN
  RAISE EXCEPTION 'Published catalogue ingredient recipe no longer matches its reviewed snapshot'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_published_catalogue_recipe() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER published_catalogue_medicine_snapshot AFTER INSERT OR UPDATE OR DELETE ON medicines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_published_catalogue_recipe();
CREATE CONSTRAINT TRIGGER published_catalogue_ingredient_snapshot AFTER INSERT OR UPDATE OR DELETE ON medicine_ingredients
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_published_catalogue_recipe();
