export type PlanPhase = {
  id: string;
  name: string;
  state: string;
  status: 'done' | 'active' | 'todo';
};

export type CheckStep = { name: string; exitCode: number; tail: string };

export type CheckRun = {
  at: string;
  filter: string | null;
  isPassed: boolean;
  steps: CheckStep[];
};

declare module 'claude-code' {
  interface PluginState {
    'dhc-steward': {
      phases: PlanPhase[];
      lastCheck: CheckRun | null;
      busy: string | null;
    };
  }
}
