import type { ConsentStatus, PortalPatient } from '@dhc/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PatientAccount } from './account';

const accepted: ConsentStatus = { consents: [], pending: [] };
const neha: PortalPatient = {
  id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  uhid: '10001',
  name: 'Neha Kapoor',
  dob: '1997-11-23',
  gender: 'female',
  language: 'en',
  relation: 'account',
  guardianPatientId: null,
};
const aarav: PortalPatient = {
  ...neha,
  id: '7a1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  name: 'Aarav Kapoor',
  relation: 'dependant',
  guardianPatientId: neha.id,
};

function setup(consents: ConsentStatus, patients: PortalPatient[]) {
  const api = { consents: vi.fn(async () => consents), patients: vi.fn(async () => patients) };
  return { account: new PatientAccount(api), api };
}

describe('PatientAccount', () => {
  it('asks for the consents first and reads no health data before them', async () => {
    const { account, api } = setup({ consents: [], pending: ['terms', 'health_data'] }, [neha]);
    await account.ensureLoaded();
    expect(account.getState()).toMatchObject({ status: 'consents' });
    expect(api.patients).not.toHaveBeenCalled();
  });

  it('asks the person to add themself when the number has no record', async () => {
    const { account } = setup(accepted, []);
    await account.ensureLoaded();
    expect(account.getState()).toEqual({ status: 'profile' });
  });

  it('selects the first patient, keeps a choice across reloads, and loads once', async () => {
    const { account, api } = setup(accepted, [neha, aarav]);
    await account.ensureLoaded();
    expect(account.getState()).toMatchObject({ status: 'ready', selectedId: neha.id });
    account.select(aarav.id);
    await account.reload();
    expect(account.getState()).toMatchObject({ selectedId: aarav.id });
    await account.ensureLoaded();
    expect(api.consents).toHaveBeenCalledTimes(2);

    account.select('not-on-this-account');
    expect(account.getState()).toMatchObject({ selectedId: aarav.id });
  });

  it('shows an error that a reload can recover from', async () => {
    const { account, api } = setup(accepted, [neha]);
    api.consents.mockRejectedValueOnce(new TypeError('offline'));
    await account.ensureLoaded();
    expect(account.getState()).toMatchObject({ status: 'error' });
    await account.ensureLoaded();
    expect(account.getState()).toMatchObject({ status: 'ready' });
  });

  it('forgets the family on sign-out', async () => {
    const { account } = setup(accepted, [neha]);
    await account.ensureLoaded();
    account.reset();
    expect(account.getState()).toEqual({ status: 'loading' });
  });
});
