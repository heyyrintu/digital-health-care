import { Prisma } from '@dhc/db';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { publicSaveError } from './service';

/** A database error as Prisma's driver adapter reports it. */
const dbError = (code: string, constraint: string) =>
  new Prisma.PrismaClientKnownRequestError('Database error', {
    code,
    clientVersion: 'test',
    meta: {
      driverAdapterError: {
        cause: {
          originalMessage: `violates constraint "${constraint}"`,
          constraint: { index: constraint },
        },
      },
    },
  });

describe('publicSaveError', () => {
  it('calls only the address’s own unique index taken', () => {
    const taken = publicSaveError(dbError('P2002', 'doctor_profiles_public_slug_key'));
    expect(taken).toBeInstanceOf(AppError);
    expect(taken).toMatchObject({ statusCode: 409, fields: { slug: 'taken' } });
    // Another unique index (a race on the profile row itself) is not the doctor's to fix.
    const other = dbError('P2002', 'doctor_profiles_organisation_id_user_id_key');
    expect(publicSaveError(other)).toBe(other);
  });

  it('turns a CHECK the contract missed into a 400 on its field', () => {
    expect(publicSaveError(dbError('P2039', 'doctor_profiles_languages_check'))).toMatchObject({
      statusCode: 400,
      fields: { languages: 'invalid' },
    });
    expect(publicSaveError(dbError('P2039', 'doctor_profiles_listed_slug_check'))).toMatchObject({
      statusCode: 400,
      fields: { slug: 'required' },
    });
    const unrelated = dbError('P2039', 'doctor_profiles_verified_check');
    expect(publicSaveError(unrelated)).toBe(unrelated);
    const plain = new Error('boom');
    expect(publicSaveError(plain)).toBe(plain);
  });
});
