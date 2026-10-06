import Constants from 'expo-constants';

export type Variant = 'patient' | 'clinic';

/** Which store app this build is, as set by app.config.ts. */
export const variant: Variant =
  Constants.expoConfig?.extra?.variant === 'clinic' ? 'clinic' : 'patient';
