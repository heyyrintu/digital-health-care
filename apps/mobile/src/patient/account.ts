import type { ConsentStatus, PortalPatient } from '@dhc/contracts';

export interface AccountApi {
  consents(): Promise<ConsentStatus>;
  patients(): Promise<PortalPatient[]>;
}

export type AccountState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  /** Onboarding: the privacy notice, terms or health-data consent still to accept. */
  | { status: 'consents'; consents: ConsentStatus }
  /** Onboarding: nobody on this number yet; the person adds themself. */
  | { status: 'profile' }
  | { status: 'ready'; patients: PortalPatient[]; selectedId: string };

/**
 * The signed-in patient account (PRD §4): which onboarding step is next, the family, and
 * whose record the screens show. Shared by every patient screen, loaded once per sign-in.
 */
export class PatientAccount {
  private state: AccountState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private loaded = false;

  constructor(private readonly api: AccountApi) {}

  getState = (): AccountState => this.state;

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
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  select(patientId: string) {
    if (this.state.status === 'ready' && this.state.patients.some((p) => p.id === patientId)) {
      this.setState({ ...this.state, selectedId: patientId });
    }
  }

  /** Signed out: forget the family. */
  reset() {
    this.loaded = false;
    this.setState({ status: 'loading' });
  }

  private async load() {
    if (this.state.status !== 'ready') this.setState({ status: 'loading' });
    try {
      const consents = await this.api.consents();
      if (consents.pending.length > 0) {
        this.setState({ status: 'consents', consents });
      } else {
        const patients = await this.api.patients();
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
      this.setState({ status: 'error', error });
    }
  }

  private setState(state: AccountState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
