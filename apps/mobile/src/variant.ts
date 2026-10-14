import Constants from 'expo-constants';

export type Variant = 'patient' | 'clinic';

/** Which store app this build is, as set by app.config.ts. */
export const variant: Variant =
  Constants.expoConfig?.extra?.variant === 'clinic' ? 'clinic' : 'patient';

/** Width at which the Clinic app switches to two panes (iPad and tablets, ADR 0005). */
export const TWO_PANE_MIN_WIDTH = 768;
