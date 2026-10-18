import { z } from 'zod';
import { CursorQuery, page } from './pagination';
import { UploadMediaType } from './settings';

// ---- Test orders (PRD §7.1) -----------------------------------------------------------
//
// The doctor orders tests on the visit's prescription draft: from the clinic's catalogue
// (blood tests, X-ray with views, MRI and CT with region and side) or as free text. They
// print under "Prescribed tests" on the signed PDF and lock with it. Results are uploaded
// against an ordered test by the front desk, the doctor or the patient; the doctor then
// marks them reviewed: ordered → result_uploaded → reviewed.

export const TestKind = z.enum(['blood', 'xray', 'mri', 'ct', 'other']);
export type TestKind = z.infer<typeof TestKind>;

/** Imaging has body regions (and a side); only X-rays have views. */
export const IMAGING_KINDS: readonly TestKind[] = ['xray', 'mri', 'ct'];

/** `na`: not applicable (a blood test, or a region with no side such as the brain). */
export const TestSide = z.enum(['left', 'right', 'both', 'na']);
export type TestSide = z.infer<typeof TestSide>;

export const TestOrderStatus = z.enum(['ordered', 'result_uploaded', 'reviewed']);
export type TestOrderStatus = z.infer<typeof TestOrderStatus>;

/** The most tests one visit can order (the API limit). */
export const MAX_TEST_ORDERS = 20;

/** The most results one ordered test can hold; a further upload is 409 `file: too_many`. */
export const MAX_RESULTS_PER_ORDER = 10;

// ---- Catalogue --------------------------------------------------------------------------

export const TestCatalogueItem = z.object({
  id: z.uuid(),
  kind: TestKind,
  name: z.string(),
  /** Body regions to pick from (imaging); empty for other tests. */
  regions: z.array(z.string()),
  /** Views to pick from (X-ray); empty for other tests. */
  views: z.array(z.string()),
});
export type TestCatalogueItem = z.infer<typeof TestCatalogueItem>;

export const TestCatalogueList = z.object({ data: z.array(TestCatalogueItem) });
export type TestCatalogueList = z.infer<typeof TestCatalogueList>;

export const TestCatalogueQuery = z.object({
  /** Name contains, any case; leave out for the whole active catalogue. */
  q: z.string().trim().max(60).optional(),
});
export type TestCatalogueQuery = z.infer<typeof TestCatalogueQuery>;

// ---- Catalogue editing (clinic admin) ---------------------------------------------------
//
// The clinic admin adds tests, renames them, edits their regions and views, reorders them
// within their kind and deactivates them. Items are never deleted (orders point at them),
// and an ordered test keeps its own copy of what was picked, so no edit reaches it.

/** The views an X-ray may offer (the seeded X-ray offers all six). */
export const XRAY_VIEWS = ['AP', 'PA', 'Lateral', 'Oblique', 'Skyline', 'Standing'] as const;
export const XrayView = z.enum(XRAY_VIEWS);
export type XrayView = z.infer<typeof XrayView>;

/** The most regions one catalogue test may list (the seeded X-ray has 20). */
export const MAX_CATALOGUE_REGIONS = 40;
/** The most tests, active or not, one clinic's catalogue may hold (the seed adds 26). */
export const MAX_CATALOGUE_ITEMS = 300;

/** Trimmed, with inner runs of spaces made one. */
const tidy = (max: number) =>
  z
    .string()
    .trim()
    .overwrite((s) => s.replace(/\s+/g, ' '))
    .min(1)
    .max(max);
const CatalogueName = tidy(120);
/** 80 at most: an ordered test copies its region, and orders allow 80. */
const CatalogueRegion = tidy(80);
const CatalogueRegions = z
  .array(CatalogueRegion)
  .max(MAX_CATALOGUE_REGIONS)
  .refine((r) => new Set(r.map((x) => x.toLowerCase())).size === r.length, {
    message: 'Each region once.',
  });
const CatalogueViews = z
  .array(XrayView)
  .max(XRAY_VIEWS.length)
  .refine((v) => new Set(v).size === v.length, { message: 'Each view once.' });

/** Only imaging has regions; only X-rays have views. Shared by create and the stored kind. */
export function catalogueShapeIssues(item: {
  kind: TestKind;
  regions?: string[];
  views?: string[];
}): { path: 'regions' | 'views'; message: string }[] {
  const issues: { path: 'regions' | 'views'; message: string }[] = [];
  if (!IMAGING_KINDS.includes(item.kind) && (item.regions?.length ?? 0) > 0) {
    issues.push({ path: 'regions', message: 'Only imaging has regions.' });
  }
  if (item.kind !== 'xray' && (item.views?.length ?? 0) > 0) {
    issues.push({ path: 'views', message: 'Only X-rays have views.' });
  }
  return issues;
}

/** A catalogue test as the clinic admin manages it: active or not, in the clinic's order. */
export const AdminTestCatalogueItem = TestCatalogueItem.extend({
  active: z.boolean(),
  sortOrder: z.number().int(),
});
export type AdminTestCatalogueItem = z.infer<typeof AdminTestCatalogueItem>;

export const AdminTestCatalogueList = z.object({ data: z.array(AdminTestCatalogueItem) });
export type AdminTestCatalogueList = z.infer<typeof AdminTestCatalogueList>;

export const CreateTestCatalogueItemBody = z
  .object({
    kind: TestKind,
    name: CatalogueName,
    regions: CatalogueRegions.default([]),
    views: CatalogueViews.default([]),
  })
  .superRefine((body, ctx) => {
    for (const issue of catalogueShapeIssues(body)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type CreateTestCatalogueItemBody = z.infer<typeof CreateTestCatalogueItemBody>;

/**
 * Any of: a new name, the whole region or view list, or active. The kind never changes
 * (add a new test instead); the shape rules apply to the stored kind.
 */
export const UpdateTestCatalogueItemBody = z
  .object({
    name: CatalogueName.optional(),
    regions: CatalogueRegions.optional(),
    views: CatalogueViews.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });
export type UpdateTestCatalogueItemBody = z.infer<typeof UpdateTestCatalogueItemBody>;

/**
 * The new order of one kind's tests: every one of that kind's tests (active or not), each
 * once. A list that no longer matches the catalogue is 409 `ids: stale`.
 */
export const ReorderTestCatalogueBody = z.object({
  kind: TestKind,
  ids: z
    .array(z.uuid())
    .min(1)
    .max(MAX_CATALOGUE_ITEMS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each test once.' }),
});
export type ReorderTestCatalogueBody = z.infer<typeof ReorderTestCatalogueBody>;

// ---- Lines on the prescription draft ----------------------------------------------------

const lineShape = {
  /** Chosen by the client (a random UUID), so edits keep it, like a medicine line. */
  id: z.uuid(),
  /** From the catalogue; null for a free-text test. */
  catalogueItemId: z.uuid().nullable(),
  kind: TestKind,
  name: z.string().trim().min(1).max(200),
  region: z.string().trim().min(1).max(80).nullable(),
  side: TestSide,
  views: z.array(z.string().trim().min(1).max(40)).max(6),
  /** For the lab or the radiologist; printed with the test. */
  notes: z.string().trim().max(500).nullable(),
};

type LineShape = {
  kind: TestKind;
  region: string | null;
  side: TestSide;
  views: string[];
};

/** Imaging rules shared by the line and the stored order. */
function checkShape(line: LineShape, ctx: z.RefinementCtx) {
  const imaging = IMAGING_KINDS.includes(line.kind);
  if (!imaging && line.region !== null) {
    ctx.addIssue({ code: 'custom', path: ['region'], message: 'Only imaging has a region.' });
  }
  if (!imaging && line.side !== 'na') {
    ctx.addIssue({ code: 'custom', path: ['side'], message: 'Only imaging has a side.' });
  }
  if (line.kind !== 'xray' && line.views.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['views'], message: 'Only X-rays have views.' });
  }
  if (new Set(line.views).size !== line.views.length) {
    ctx.addIssue({ code: 'custom', path: ['views'], message: 'Each view once.' });
  }
}

/** A test as the doctor writes it on the draft. */
export const TestOrderLine = z.object(lineShape).superRefine(checkShape);
export type TestOrderLine = z.infer<typeof TestOrderLine>;

/** An uploaded result: what it is and who sent it, never the file itself. */
export const TestResultSummary = z.object({
  id: z.uuid(),
  mediaType: UploadMediaType,
  sizeBytes: z.number().int().positive(),
  uploadedAt: z.iso.datetime(),
  /** `patient` from the Patient app or portal; otherwise the clinic's staff. */
  uploadedBy: z.enum(['patient', 'clinic']),
});
export type TestResultSummary = z.infer<typeof TestResultSummary>;

/**
 * A visit's test: a draft line until the prescription is signed, then an order. For the
 * front desk `notes` is always null: the doctor's notes are clinical content (the doctor
 * and the patient, whose PDF prints them, see them).
 */
export const TestOrder = z.object({
  ...lineShape,
  status: TestOrderStatus,
  /** When a signed prescription first ordered it; null while still a draft line. */
  orderedAt: z.iso.datetime().nullable(),
  resultUploadedAt: z.iso.datetime().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  /** Oldest first. */
  results: z.array(TestResultSummary),
});
export type TestOrder = z.infer<typeof TestOrder>;

// ---- Lists ------------------------------------------------------------------------------

/** One of a patient's ordered tests, as the patient profile lists them. */
export const PatientTestOrder = TestOrder.extend({
  appointmentId: z.uuid(),
  /** The visit date, `YYYY-MM-DD` (IST). */
  visitDate: z.iso.date(),
  doctorName: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  /** The signed-in doctor may mark it reviewed now (a result waits for review). */
  canReview: z.boolean(),
});
export type PatientTestOrder = z.infer<typeof PatientTestOrder>;

/** `?limit=50&cursor=`: newest orders first, a page at a time. */
export const TestOrderListQuery = CursorQuery;
export type TestOrderListQuery = z.infer<typeof TestOrderListQuery>;

export const PatientTestOrderList = page(PatientTestOrder);
export type PatientTestOrderList = z.infer<typeof PatientTestOrderList>;

/** The doctor's results waiting for review (the dashboard's in-app notification). */
export const AwaitingReviewList = z.object({
  /** All of them; `data` holds the oldest 50. */
  count: z.number().int().min(0),
  data: z.array(
    z.object({
      id: z.uuid(),
      kind: TestKind,
      name: z.string(),
      region: z.string().nullable(),
      side: TestSide,
      views: z.array(z.string()),
      resultUploadedAt: z.iso.datetime(),
      visitDate: z.iso.date(),
      patient: z.object({ id: z.uuid(), name: z.string(), uhid: z.string() }),
    }),
  ),
});
export type AwaitingReviewList = z.infer<typeof AwaitingReviewList>;

/** The family's ordered tests in the Patient app (PRD §4.4). */
export const PortalTestOrder = z.object({
  id: z.uuid(),
  patient: z.object({ id: z.uuid(), name: z.string() }),
  doctorName: z.string().nullable(),
  /** The visit date, `YYYY-MM-DD` (IST). */
  visitDate: z.iso.date(),
  kind: TestKind,
  name: z.string(),
  region: z.string().nullable(),
  side: TestSide,
  views: z.array(z.string()),
  notes: z.string().nullable(),
  status: TestOrderStatus,
  orderedAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  results: z.array(TestResultSummary),
});
export type PortalTestOrder = z.infer<typeof PortalTestOrder>;

export const PortalTestOrderList = page(PortalTestOrder);
export type PortalTestOrderList = z.infer<typeof PortalTestOrderList>;
