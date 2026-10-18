import type { ConsentStatus, PortalPatient } from '@dhc/contracts';

export interface PatientAccountApi {
  consents(): Promise<ConsentStatus>;
  patients(): Promise<PortalPatient[]>;
}

export type PatientAccountState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  /** Onboarding: the privacy notice, terms or health-data consent still to accept. */
  | { status: 'consents'; consents: ConsentStatus }
  /** Onboarding: nobody on this number yet; the person adds themself. */
  | { status: 'profile' }
  | { status: 'ready'; patients: PortalPatient[]; selectedId: string };

/**
 * The signed-in patient account (PRD §4): which onboarding step is next, the family, and
 * whose record the screens show. Shared by every patient screen, on the web portal and in
 * the Patient app, and loaded once per sign-in.
 */
export class PatientAccount {
  private state: PatientAccountState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  /** Bumped by `reset`, so a load started before sign-out cannot fill the store after it. */
  private generation = 0;

  constructor(private readonly api: PatientAccountApi) {}

  getState = (): PatientAccountState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Loads once; later calls reuse the result until `reload` or `reset`. */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    return this.reload();
  }

  reload(): Promise<void> {
    if (!this.loading) {
      const loading = this.load(this.generation).finally(() => {
        if (this.loading === loading) this.loading = null;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  select(patientId: string) {
    if (this.state.status === 'ready' && this.state.patients.some((p) => p.id === patientId)) {
      this.setState({ ...this.state, selectedId: patientId });
    }
  }

  /** Signed out: forget the family. */
  reset() {
    this.generation += 1;
    this.loading = null;
    this.loaded = false;
    this.setState({ status: 'loading' });
  }

  private async load(generation: number) {
    const current = () => generation === this.generation;
    if (this.state.status !== 'ready') this.setState({ status: 'loading' });
    try {
      const consents = await this.api.consents();
      if (!current()) return;
      if (consents.pending.length > 0) {
        this.setState({ status: 'consents', consents });
      } else {
        const patients = await this.api.patients();
        if (!current()) return;
        if (patients.length === 0) {
          this.setState({ status: 'profile' });
        } else {
          const previous = this.state.status === 'ready' ? this.state.selectedId : undefined;
          const selectedId = patients.some((p) => p.id === previous) ? previous! : patients[0]!.id;
          this.setState({ status: 'ready', patients, selectedId });
        }
      }
      this.loaded = true;
    } catch (error) {
      if (current()) this.setState({ status: 'error', error });
    }
  }

  private setState(state: PatientAccountState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
