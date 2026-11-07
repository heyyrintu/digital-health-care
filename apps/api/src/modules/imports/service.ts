import { createHash, randomUUID } from 'node:crypto';
import {
  CreatePatientBody,
  ImportRow,
  PatientImport,
  parseImportCsv,
  type PreviewPatientImport,
} from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { normaliseIndianMobile } from '../../auth/phone';
import { allocateUhid } from '../patients/service';
import { writeAudit } from '../audit/write';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clean = (v: string) => v.trim().replace(/\s+/g, ' ');
const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
type Actor = { userId: string; organisationId: string };
type Job = Awaited<ReturnType<Tx['patientImportJob']['findUniqueOrThrow']>>;
export class PatientImportsService {
  constructor(private s: Services) {}
  private decode(cipher: string) {
    return ImportRow.array().parse(JSON.parse(this.s.cipher.decrypt(cipher)));
  }
  private view(j: Job) {
    const rows = this.decode(j.resultCipher ?? j.payloadCipher);
    return PatientImport.parse({
      ...j,
      createdAt: j.createdAt.toISOString(),
      expiresAt: j.expiresAt.toISOString(),
      appliedAt: j.appliedAt?.toISOString() ?? null,
      rows,
      newCount: rows.filter((r) => r.state === 'new').length,
      skippedCount: rows.filter((r) => r.state === 'already_imported').length,
      errorCount: rows.filter((r) => r.state === 'error').length,
    });
  }
  private async get(tx: Tx, id: string) {
    const j = await tx.patientImportJob.findUnique({ where: { id } });
    if (!j) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    return j;
  }
  async list(a: Actor) {
    return withTenant(this.s.db, a.organisationId, async (tx) => ({
      data: (
        await tx.patientImportJob.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: { id: true, source: true, status: true, createdAt: true },
        })
      ).map((j) => ({ ...j, createdAt: j.createdAt.toISOString() })),
    }));
  }
  async read(req: FastifyRequest, a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const j = await this.get(tx, id);
      await this.audit(tx, req, a, 'import.viewed', id);
      return this.view(j);
    });
  }
  private normalize(b: PreviewPatientImport): ImportRow[] {
    if (Buffer.byteLength(b.csv, 'utf8') > 262144)
      throw new AppError(400, 'VALIDATION_FAILED', 'Use a UTF-8 CSV of at most 256 KiB.');
    let table: string[][];
    try {
      table = parseImportCsv(b.csv);
    } catch (e) {
      throw new AppError(400, 'VALIDATION_FAILED', (e as Error).message);
    }
    const headers = table[0]!,
      keys = Object.values(b.mapping).filter(Boolean);
    if (new Set(keys).size !== keys.length || keys.some((k) => !headers.includes(k)))
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Map each selected column once using an existing header.',
      );
    const get = (row: string[], field: keyof PreviewPatientImport['mapping']) => {
      const h = b.mapping[field];
      return h ? row[headers.indexOf(h)]! : '';
    };
    return table.slice(1).map((row, index) => {
      const issues: string[] = [],
        externalId = get(row, 'externalId'),
        name = clean(get(row, 'name')),
        rawPhone = get(row, 'phone'),
        phone = normaliseIndianMobile(rawPhone),
        dob = get(row, 'dob') || null,
        gender = get(row, 'gender').toLowerCase() || null,
        email = get(row, 'email').toLowerCase() || null,
        address = get(row, 'address') || null,
        uhid = get(row, 'uhid').toUpperCase() || null;
      if (!/^[A-Za-z0-9_.:/-]{1,100}$/.test(externalId))
        issues.push('External ID: use 1–100 letters, digits or . _ : / -');
      if (!phone)
        issues.push(
          'A valid Indian mobile number is required; guardian links must be registered separately.',
        );
      if (dob && dob < `${this.s.now().getUTCFullYear() - 130}-01-01`)
        issues.push('Date of birth must be within the past 130 years.');
      if (dob && dob > this.s.now().toISOString().slice(0, 10))
        issues.push('Date of birth cannot be in the future.');
      if (uhid && !/^[A-Z0-9/-]{1,40}$/.test(uhid))
        issues.push('UHID: use 1–40 letters, digits, / or -');
      const parsed = CreatePatientBody.safeParse({ name, phone, dob, gender, email, address });
      if (!parsed.success)
        issues.push(...parsed.error.issues.map((e) => `Invalid ${e.path.join('.')}.`));
      const normalized = {
        externalId,
        name,
        phone,
        dob,
        gender: parsed.success ? (parsed.data.gender ?? null) : null,
        email,
        address,
        uhid,
      };
      return ImportRow.parse({
        ...normalized,
        row: index + 2,
        issues,
        warnings: [],
        state: issues.length ? 'error' : 'new',
        patientId: null,
        rowHash: hash(normalized),
      });
    });
  }
  private async check(tx: Tx, source: string, input: ImportRow[]): Promise<ImportRow[]> {
    const rows: ImportRow[] = input.map((r) => ({
      ...r,
      issues: [...r.issues],
      warnings: [] as string[],
      patientId: null as string | null,
      state: r.issues.length ? ('error' as const) : ('new' as const),
    }));
    for (const r of rows) {
      if (rows.some((x) => x !== r && x.externalId === r.externalId))
        r.issues.push('Repeated external ID in this file.');
      if (r.uhid && rows.some((x) => x !== r && x.uhid === r.uhid))
        r.issues.push('Repeated UHID in this file.');
      if (
        rows.some(
          (x) =>
            x !== r &&
            x.name.toLowerCase() === r.name.toLowerCase() &&
            ((r.phone && x.phone === r.phone) || (r.dob && x.dob === r.dob)),
        )
      )
        r.issues.push('Possible duplicate patient in this file.');
      const old = await tx.patientImportRecord.findFirst({
        where: { source, externalId: r.externalId },
      });
      if (old) {
        if (old.rowHash !== r.rowHash)
          r.issues.push(
            'This external ID was imported with different data; review the existing record manually.',
          );
        else {
          const p = await tx.patient.findUnique({ where: { id: old.patientId } });
          if (!p || p.mergedIntoId || p.portalClosedAt)
            r.issues.push('Previously imported record is merged or closed; review it manually.');
          else {
            r.patientId = p.id;
            r.state = 'already_imported';
          }
        }
      }
      if (!old && !r.issues.length) {
        const duplicate = await tx.patient.findFirst({
          where: {
            OR: [
              ...(r.uhid ? [{ uhid: r.uhid }] : []),
              {
                name: { equals: r.name, mode: 'insensitive' },
                OR: [
                  { phone: r.phone },
                  ...(r.dob ? [{ dob: new Date(r.dob + 'T00:00:00Z') }] : []),
                ],
              },
            ],
          },
          select: { id: true },
        });
        if (duplicate)
          r.issues.push(
            'Possible existing patient or UHID match; review manually. Existing records are never overwritten.',
          );
      }
      if (
        r.phone &&
        (rows.some((x) => x !== r && x.phone === r.phone) ||
          (await tx.patient.count({
            where: {
              phone: r.phone,
              id: { not: r.patientId ?? '00000000-0000-0000-0000-000000000000' },
            },
          })))
      )
        r.warnings.push('Shared mobile number: confirm this is the intended family contact.');
      if (r.issues.length) r.state = 'error';
    }
    return rows;
  }
  async preview(req: FastifyRequest, a: Actor, b: PreviewPatientImport) {
    const normalized = this.normalize(b),
      inputHash = hash(b);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId},84))`;
      const existing = await tx.patientImportJob.findUnique({ where: { id: b.id } });
      if (existing) {
        if (existing.inputHash !== inputHash || existing.createdByUserId !== a.userId)
          throw conflict('Import ID already belongs to a different preview.');
        return this.view(existing);
      }
      const rows = await this.check(tx, b.source, normalized),
        createdAt = this.s.now();
      const j = await tx.patientImportJob.create({
        data: {
          id: b.id,
          organisationId: a.organisationId,
          createdByUserId: a.userId,
          source: b.source,
          inputHash,
          payloadCipher: this.s.cipher.encrypt(JSON.stringify(rows)),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 86400000),
        },
      });
      await this.audit(tx, req, a, 'import.previewed', j.id, {
        rows: rows.length,
        errors: rows.filter((r) => r.state === 'error').length,
      });
      return this.view(j);
    });
  }
  async apply(req: FastifyRequest, a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId},84))`;
      const j = await this.get(tx, id);
      if (j.createdByUserId !== a.userId)
        throw new AppError(403, 'FORBIDDEN', 'Only the preview creator may confirm it.');
      if (j.status === 'applied') return this.view(j);
      if (j.status !== 'preview' || j.expiresAt <= this.s.now())
        throw conflict('This preview is cancelled or expired. Create a new preview.');
      const original = this.decode(j.payloadCipher);
      if (original.some((r) => r.state === 'error'))
        throw conflict('Correct all errors and create a new preview.');
      // Use the same phone locks as manual registration; deterministic ordering avoids batch lock cycles.
      for (const phone of [
        ...new Set(original.map((r) => r.phone).filter((p): p is string => !!p)),
      ].sort())
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'auth-phone:' + phone},0))`;
      const current = await this.check(
        tx,
        j.source,
        original.map((r) => ({ ...r, issues: [] })),
      );
      if (
        current.some(
          (r, i) =>
            r.state !== original[i]!.state ||
            r.patientId !== original[i]!.patientId ||
            JSON.stringify(r.warnings) !== JSON.stringify(original[i]!.warnings),
        )
      )
        throw conflict('Patient matches changed since this preview. Create a new dry run.');
      for (const r of current.filter((r) => r.state === 'new')) {
        const p = await tx.patient.create({
          data: {
            organisationId: a.organisationId,
            createdByUserId: a.userId,
            name: r.name,
            phone: r.phone,
            dob: r.dob ? new Date(r.dob + 'T00:00:00Z') : null,
            gender: r.gender,
            email: r.email,
            address: r.address,
            uhid:
              r.uhid ??
              (await allocateUhid(
                tx,
                a.organisationId,
                current.flatMap((row) => (row.uhid ? [row.uhid] : [])),
              )),
          },
        });
        r.patientId = p.id;
        r.uhid = p.uhid;
        await tx.patientImportRecord.create({
          data: {
            id: randomUUID(),
            organisationId: a.organisationId,
            jobId: id,
            source: j.source,
            externalId: r.externalId,
            rowHash: r.rowHash,
            patientId: p.id,
          },
        });
        await writeAudit(tx, req, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          action: 'patient.created',
          entityType: 'patient',
          entityId: p.id,
          metadata: { importJobId: id },
        });
      }
      const saved = await tx.patientImportJob.update({
        where: { id },
        data: {
          status: 'applied',
          appliedAt: this.s.now(),
          resultCipher: this.s.cipher.encrypt(JSON.stringify(current)),
        },
      });
      await this.audit(tx, req, a, 'import.applied', id, {
        created: current.filter((r) => r.state === 'new').length,
        skipped: current.filter((r) => r.state === 'already_imported').length,
      });
      return this.view(saved);
    });
  }
  async cancel(req: FastifyRequest, a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId},84))`;
      const j = await this.get(tx, id);
      if (j.createdByUserId !== a.userId)
        throw new AppError(403, 'FORBIDDEN', 'Only the preview creator may cancel it.');
      if (j.status === 'applied') throw conflict('Applied imports cannot be cancelled or deleted.');
      if (j.status === 'preview') {
        await tx.patientImportJob.update({ where: { id }, data: { status: 'cancelled' } });
        await this.audit(tx, req, a, 'import.cancelled', id);
      }
      return this.view(await this.get(tx, id));
    });
  }
  private audit(
    tx: Tx,
    req: FastifyRequest,
    a: Actor,
    action: string,
    id: string,
    metadata?: { [key: string]: number },
  ) {
    return writeAudit(tx, req, {
      organisationId: a.organisationId,
      actorUserId: a.userId,
      action,
      entityType: 'patient_import',
      entityId: id,
      metadata,
    });
  }
}
