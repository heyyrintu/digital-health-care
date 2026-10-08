-- CreateEnum
CREATE TYPE "DrugRisk" AS ENUM ('caution', 'contraindicated');

-- CreateEnum
CREATE TYPE "TelemedicineList" AS ENUM ('o', 'a', 'b', 'prohibited');

-- CreateEnum
CREATE TYPE "InteractionSeverity" AS ENUM ('contraindicated', 'major', 'moderate', 'minor');

-- CreateEnum
CREATE TYPE "StrengthPer" AS ENUM ('unit', 'ml');

-- CreateEnum
CREATE TYPE "SafetySeverity" AS ENUM ('block', 'warn', 'info');

-- CreateEnum
CREATE TYPE "SafetyAlertAction" AS ENUM ('acknowledged', 'overridden', 'changed');

-- AlterTable
ALTER TABLE "drug_molecules" ADD COLUMN     "child_dose_overridable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "child_max_mg_per_kg_day" DECIMAL(8,2),
ADD COLUMN     "child_min_mg_per_kg_day" DECIMAL(8,2),
ADD COLUMN     "hepatic_caution" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lactation" "DrugRisk",
ADD COLUMN     "max_daily_mg" DECIMAL(10,2),
ADD COLUMN     "max_dose_overridable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "older_adult_caution" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pregnancy" "DrugRisk",
ADD COLUMN     "pregnancy_overridable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "renal_adjustment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "telemedicine_list" "TelemedicineList",
ADD COLUMN     "weight_based" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "drug_interactions" (
    "id" UUID NOT NULL,
    "molecule_a_id" UUID NOT NULL,
    "molecule_b_id" UUID NOT NULL,
    "severity" "InteractionSeverity" NOT NULL,
    "overridable" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "drug_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_cross_sensitivities" (
    "allergy_class" TEXT NOT NULL,
    "drug_class" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "drug_cross_sensitivities_pkey" PRIMARY KEY ("allergy_class","drug_class")
);

-- CreateTable
CREATE TABLE "drug_condition_rules" (
    "id" UUID NOT NULL,
    "molecule_id" UUID,
    "drug_class" TEXT,
    "condition_codes" TEXT[],
    "condition_terms" TEXT[],
    "note" TEXT NOT NULL,

    CONSTRAINT "drug_condition_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_database" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "version" TEXT NOT NULL,
    "loaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_database_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicine_ingredients" (
    "medicine_id" UUID NOT NULL,
    "molecule_id" UUID NOT NULL,
    "strength_mg" DECIMAL(10,3),
    "per" "StrengthPer",

    CONSTRAINT "medicine_ingredients_pkey" PRIMARY KEY ("medicine_id","molecule_id")
);

-- CreateTable
CREATE TABLE "safety_alerts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "prescription_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "item_id" UUID,
    "severity" "SafetySeverity" NOT NULL,
    "overridable" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "first_shown_at" TIMESTAMPTZ(3) NOT NULL,
    "last_shown_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "action" "SafetyAlertAction",
    "reason" TEXT,
    "action_by_user_id" UUID,
    "action_at" TIMESTAMPTZ(3),
    "drug_database_version" TEXT NOT NULL,

    CONSTRAINT "safety_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drug_interactions_molecule_b_id_idx" ON "drug_interactions"("molecule_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "drug_interactions_molecule_a_id_molecule_b_id_key" ON "drug_interactions"("molecule_a_id", "molecule_b_id");

-- CreateIndex
CREATE INDEX "drug_condition_rules_molecule_id_idx" ON "drug_condition_rules"("molecule_id");

-- CreateIndex
CREATE INDEX "drug_condition_rules_drug_class_idx" ON "drug_condition_rules"("drug_class");

-- CreateIndex
CREATE INDEX "medicine_ingredients_molecule_id_idx" ON "medicine_ingredients"("molecule_id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_alerts_prescription_id_key_key" ON "safety_alerts"("prescription_id", "key");

-- AddForeignKey
ALTER TABLE "drug_interactions" ADD CONSTRAINT "drug_interactions_molecule_a_id_fkey" FOREIGN KEY ("molecule_a_id") REFERENCES "drug_molecules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_interactions" ADD CONSTRAINT "drug_interactions_molecule_b_id_fkey" FOREIGN KEY ("molecule_b_id") REFERENCES "drug_molecules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_condition_rules" ADD CONSTRAINT "drug_condition_rules_molecule_id_fkey" FOREIGN KEY ("molecule_id") REFERENCES "drug_molecules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_ingredients" ADD CONSTRAINT "medicine_ingredients_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "medicines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_ingredients" ADD CONSTRAINT "medicine_ingredients_molecule_id_fkey" FOREIGN KEY ("molecule_id") REFERENCES "drug_molecules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_alerts" ADD CONSTRAINT "safety_alerts_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Medicines now list their molecules as ingredients (with a foreign key and, when known, a
-- strength) instead of an array of molecule IDs. Existing links move across first.
-- The old array had no foreign key, so links to missing molecules are left behind.
INSERT INTO "medicine_ingredients" ("medicine_id", "molecule_id")
  SELECT m.id, mm
  FROM "medicines" m, unnest(m.molecule_ids) AS mm
  WHERE mm IS NOT NULL
    AND EXISTS (SELECT 1 FROM "drug_molecules" dm WHERE dm.id = mm)
  ON CONFLICT DO NOTHING;
ALTER TABLE "medicines" DROP COLUMN "molecule_ids";

-- Guard rails.
ALTER TABLE drug_interactions ADD CONSTRAINT drug_interactions_pair_order_check
  CHECK (molecule_a_id < molecule_b_id);
ALTER TABLE drug_condition_rules ADD CONSTRAINT drug_condition_rules_target_check
  CHECK ((molecule_id IS NULL) <> (drug_class IS NULL));
ALTER TABLE drug_condition_rules ADD CONSTRAINT drug_condition_rules_match_check
  CHECK (cardinality(condition_codes) + cardinality(condition_terms) > 0);
ALTER TABLE drug_database ADD CONSTRAINT drug_database_single_row_check CHECK (id = 1);
ALTER TABLE drug_molecules ADD CONSTRAINT drug_molecules_child_range_check
  CHECK (child_min_mg_per_kg_day IS NULL OR child_max_mg_per_kg_day IS NULL
         OR child_min_mg_per_kg_day <= child_max_mg_per_kg_day);
ALTER TABLE medicine_ingredients ADD CONSTRAINT medicine_ingredients_strength_check
  CHECK ((strength_mg IS NULL) = (per IS NULL) AND (strength_mg IS NULL OR strength_mg > 0));
ALTER TABLE safety_alerts ADD CONSTRAINT safety_alerts_override_reason_check
  CHECK (action IS DISTINCT FROM 'overridden' OR reason IS NOT NULL);

-- Reference drug data is platform-wide and read-only to clinics, like drug_molecules.
GRANT SELECT ON drug_interactions, drug_cross_sensitivities, drug_condition_rules, drug_database
  TO dhc_app;

-- Ingredients follow their medicine: a clinic reads those of every medicine it can see and
-- writes only those of its own medicines.
ALTER TABLE medicine_ingredients ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON medicine_ingredients TO dhc_app;
CREATE POLICY tenant_read ON medicine_ingredients FOR SELECT TO dhc_app
  USING (EXISTS (SELECT 1 FROM public.medicines m WHERE m.id = medicine_id));
CREATE POLICY tenant_write ON medicine_ingredients FOR ALL TO dhc_app
  USING (EXISTS (SELECT 1 FROM public.medicines m
                 WHERE m.id = medicine_id AND m.organisation_id = app_current_organisation_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.medicines m
                      WHERE m.id = medicine_id AND m.organisation_id = app_current_organisation_id()));

-- Alerts are the safety log: added and updated, never deleted.
ALTER TABLE safety_alerts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON safety_alerts TO dhc_app;
CREATE POLICY tenant_isolation ON safety_alerts TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- An alert belongs to a prescription of the same organisation (foreign keys ignore RLS).
CREATE FUNCTION safety_alerts_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.prescriptions p
    WHERE p.id = NEW.prescription_id AND p.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'safety alert does not match its prescription' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER safety_alerts_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, prescription_id
  ON safety_alerts FOR EACH ROW EXECUTE FUNCTION safety_alerts_same_tenant();
-- Only this trigger uses it; no role may attach it elsewhere.
REVOKE EXECUTE ON FUNCTION safety_alerts_same_tenant() FROM PUBLIC;
