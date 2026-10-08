import { DoseStep, type SafetyAlert, type SafetySummary } from '@dhc/contracts';
import type { Prisma } from '@dhc/db';
import { type Tx } from '@dhc/db';
import { ageFrom } from '@dhc/domain';
import {
  checkPrescription,
  type DrugFacts,
  type SafetyFinding,
  type SafetyInput,
  type SafetyLine,
} from '@dhc/safety';
import { z } from 'zod';

const Steps = z.array(DoseStep);
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

type ItemRow = Prisma.PrescriptionItemGetPayload<object>;
type AlertRow = Prisma.SafetyAlertGetPayload<object>;

/** The visit the prescription belongs to, as loaded by the prescribing service. */
export interface SafetyVisit {
  id: string;
  patientId: string;
  doctorUserId: string;
  date: Date;
  startAt: Date;
  consultationTypeId: string;
}

/**
 * Everything the engine needs, read inside the caller's tenant transaction: the patient's
 * chart (active entries only), today's vitals, the consultation mode, and the drug facts
 * for the molecules the lines, allergies and current medicines refer to.
 */
async function loadInput(tx: Tx, visit: SafetyVisit, items: ItemRow[]): Promise<SafetyInput> {
  // One query at a time: a transaction's connection runs them in order anyway.
  const patient = await tx.patient.findUniqueOrThrow({
    where: { id: visit.patientId },
    select: { dob: true },
  });
  const vitals = await tx.vitals.findUnique({
    where: { appointmentId: visit.id },
    select: { weightKg: true, pregnancyStatus: true },
  });
  const type = await tx.consultationType.findUniqueOrThrow({
    where: { id: visit.consultationTypeId },
    select: { mode: true },
  });
  const active = { patientId: visit.patientId, removedAt: null };
  const allergies = await tx.allergy.findMany({ where: active });
  const conditions = await tx.medicalCondition.findMany({ where: active });
  const medications = await tx.currentMedication.findMany({ where: active });
  // A follow-up (SR-19): the same doctor saw this patient at an earlier, completed visit.
  const earlier = await tx.appointment.count({
    where: {
      patientId: visit.patientId,
      doctorUserId: visit.doctorUserId,
      status: 'completed',
      startAt: { lt: visit.startAt },
    },
  });

  const medicineIds = [...new Set(items.flatMap((i) => (i.medicineId ? [i.medicineId] : [])))];
  const ingredients = medicineIds.length
    ? await tx.medicineIngredient.findMany({ where: { medicineId: { in: medicineIds } } })
    : [];

  // Molecules named in the chart's free text (allergies, current medicines), directly or by
  // class; the engine then matches whole words.
  const texts = [...allergies.map((a) => a.substance), ...medications.map((m) => m.name)];
  const named = texts.length
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM drug_molecules m
        WHERE EXISTS (
          SELECT 1 FROM unnest(${texts}::text[]) AS t(text)
          WHERE position(lower(m.name) IN lower(t.text)) > 0
             OR (m.drug_class IS NOT NULL AND position(lower(m.drug_class) IN lower(t.text)) > 0)
        )`
    : [];
  const moleculeIds = [
    ...new Set([...ingredients.map((i) => i.moleculeId), ...named.map((n) => n.id)]),
  ];
  const molecules = moleculeIds.length
    ? await tx.drugMolecule.findMany({ where: { id: { in: moleculeIds } } })
    : [];
  const lineMolecules = new Set(ingredients.map((i) => i.moleculeId));
  const lineClasses = [
    ...new Set(
      molecules.flatMap((m) => (lineMolecules.has(m.id) && m.drugClass ? [m.drugClass] : [])),
    ),
  ];
  const interactions = moleculeIds.length
    ? await tx.drugInteraction.findMany({
        where: { moleculeAId: { in: moleculeIds }, moleculeBId: { in: moleculeIds } },
      })
    : [];
  const crossSensitivities = await tx.drugCrossSensitivity.findMany();
  const conditionRules = await tx.drugConditionRule.findMany({
    where: { OR: [{ moleculeId: { in: [...lineMolecules] } }, { drugClass: { in: lineClasses } }] },
  });
  const database = await tx.drugDatabase.findUnique({ where: { id: 1 } });

  const facts: DrugFacts = {
    version: database?.version ?? 'none',
    molecules: molecules.map((m) => ({
      id: m.id,
      name: m.name,
      drugClass: m.drugClass,
      pregnancy: m.pregnancy,
      pregnancyOverridable: m.pregnancyOverridable,
      lactation: m.lactation,
      weightBased: m.weightBased,
      childMinMgPerKgDay: num(m.childMinMgPerKgDay),
      childMaxMgPerKgDay: num(m.childMaxMgPerKgDay),
      childDoseOverridable: m.childDoseOverridable,
      maxDailyMg: num(m.maxDailyMg),
      maxDoseOverridable: m.maxDoseOverridable,
      olderAdultCaution: m.olderAdultCaution,
      renalAdjustment: m.renalAdjustment,
      hepaticCaution: m.hepaticCaution,
      telemedicineList: m.telemedicineList,
    })),
    interactions: interactions.map((i) => ({
      moleculeAId: i.moleculeAId,
      moleculeBId: i.moleculeBId,
      severity: i.severity,
      overridable: i.overridable,
      note: i.note,
    })),
    crossSensitivities,
    conditionRules,
  };

  const byMedicine = new Map<string, SafetyLine['ingredients']>();
  for (const i of ingredients) {
    const list = byMedicine.get(i.medicineId) ?? [];
    list.push({ moleculeId: i.moleculeId, strengthMg: num(i.strengthMg), per: i.per });
    byMedicine.set(i.medicineId, list);
  }

  return {
    patient: {
      ageYears: patient.dob
        ? ageFrom(patient.dob.toISOString().slice(0, 10), visit.date.toISOString().slice(0, 10))
            .years
        : null,
      weightKg: num(vitals?.weightKg ?? null),
      pregnancy: vitals?.pregnancyStatus ?? null,
    },
    allergies: allergies.map((a) => ({ id: a.id, substance: a.substance, source: a.source })),
    conditions: conditions.map((c) => ({
      id: c.id,
      name: c.name,
      icd10Code: c.icd10Code,
      source: c.source,
    })),
    currentMedications: medications.map((m) => ({ id: m.id, name: m.name, source: m.source })),
    consultation: { mode: type.mode, followUp: earlier > 0 },
    lines: items.map((i) => ({
      id: i.id,
      name: i.name,
      medicineId: i.medicineId,
      ingredients: i.medicineId ? (byMedicine.get(i.medicineId) ?? []) : [],
      steps: Steps.parse(i.steps),
    })),
    facts,
  };
}

/** The engine's findings with the doctor's answers from the safety log. */
export function summarise(
  findings: SafetyFinding[],
  rows: Map<string, AlertRow>,
  version: string,
): SafetySummary {
  const alerts: SafetyAlert[] = findings.map((f) => {
    const row = rows.get(f.key);
    const action =
      row?.action === 'acknowledged' || row?.action === 'overridden' ? row.action : null;
    return {
      key: f.key,
      ruleId: f.ruleId,
      severity: f.severity,
      itemId: f.itemId,
      overridable: f.overridable,
      reasonRequired: f.reasonRequired,
      unverified: f.unverified,
      params: f.params,
      message: f.message,
      action,
      reason: action ? (row?.reason ?? null) : null,
      actionAt: action ? (row?.actionAt?.toISOString() ?? null) : null,
    };
  });
  return {
    alerts,
    drugDatabaseVersion: version,
    openBlocks: alerts.filter(
      (a) => a.severity === 'block' && !(a.overridable && a.action === 'overridden'),
    ).length,
    openWarnings: alerts.filter((a) => a.severity === 'warn' && a.action !== 'acknowledged').length,
  };
}

/**
 * Checks a draft against the current chart and records the result in the safety log:
 * new alerts are added, alerts that fire again are marked shown, and alerts that no
 * longer fire are resolved — as `changed` when the doctor had not acted on them. With
 * `persist` false (a prescription that can no longer change) nothing is written.
 */
export async function checkAndRecord(
  tx: Tx,
  opts: {
    visit: SafetyVisit;
    prescriptionId: string;
    organisationId: string;
    actorUserId: string;
    items: ItemRow[];
    persist: boolean;
    now: Date;
  },
): Promise<{ summary: SafetySummary; findings: SafetyFinding[] }> {
  const input = await loadInput(tx, opts.visit, opts.items);
  const findings = checkPrescription(input);
  const version = input.facts.version;
  const existing = await tx.safetyAlert.findMany({
    where: { prescriptionId: opts.prescriptionId },
  });
  const rows = new Map(existing.map((r) => [r.key, r]));

  if (opts.persist) {
    const firing = new Set(findings.map((f) => f.key));
    for (const f of findings) {
      const row = rows.get(f.key);
      const data = {
        ruleId: f.ruleId,
        itemId: f.itemId,
        severity: f.severity,
        overridable: f.overridable,
        message: f.message,
        params: f.params,
        lastShownAt: opts.now,
        drugDatabaseVersion: version,
      };
      if (!row) {
        rows.set(
          f.key,
          await tx.safetyAlert.create({
            data: {
              ...data,
              organisationId: opts.organisationId,
              prescriptionId: opts.prescriptionId,
              key: f.key,
              firstShownAt: opts.now,
            },
          }),
        );
      } else {
        // An alert resolved by a change that fires again is open again.
        const reopened = row.resolvedAt !== null && row.action === 'changed';
        rows.set(
          f.key,
          await tx.safetyAlert.update({
            where: { id: row.id },
            data: {
              ...data,
              resolvedAt: null,
              ...(reopened ? { action: null, actionByUserId: null, actionAt: null } : {}),
            },
          }),
        );
      }
    }
    const gone = existing.filter((r) => r.resolvedAt === null && !firing.has(r.key));
    for (const r of gone) {
      await tx.safetyAlert.update({
        where: { id: r.id },
        data: {
          resolvedAt: opts.now,
          ...(r.action === null
            ? { action: 'changed', actionByUserId: opts.actorUserId, actionAt: opts.now }
            : {}),
        },
      });
    }
  }
  return { summary: summarise(findings, rows, version), findings };
}
