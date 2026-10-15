import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * One Expo project, two store apps (ADR 0004). The EAS build profile sets APP_VARIANT.
 * Bundle IDs stay placeholders until the publishing legal entity is decided (ADR 0011).
 */
type Variant = 'patient' | 'clinic';

const variant: Variant = process.env.APP_VARIANT === 'clinic' ? 'clinic' : 'patient';
const idPrefix = process.env.BUNDLE_ID_PREFIX ?? 'dev.dhc';

// Store and preview builds must call a real API, never the localhost development default.
const profile = process.env.EAS_BUILD_PROFILE ?? '';
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
if (/^(preview|production)-/.test(profile)) {
  if (!apiBaseUrl) throw new Error(`EXPO_PUBLIC_API_BASE_URL must be set for the ${profile} build`);
  // A loopback address points the device at itself, not at the API.
  const { hostname } = new URL(apiBaseUrl);
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(hostname)) {
    throw new Error(`EXPO_PUBLIC_API_BASE_URL must not be a loopback address for ${profile}`);
  }
}

const VARIANTS: Record<Variant, Pick<ExpoConfig, 'name' | 'slug' | 'scheme' | 'orientation'>> = {
  patient: { name: 'Patient', slug: 'dhc-patient', scheme: 'dhc-patient', orientation: 'portrait' },
  // Clinic app supports landscape for the iPad and tablet two-pane layout (ADR 0005).
  clinic: { name: 'Clinic', slug: 'dhc-clinic', scheme: 'dhc-clinic', orientation: 'default' },
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  ...VARIANTS[variant],
  version: '0.0.0',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: `${idPrefix}.${variant}`,
    supportsTablet: true,
    // Split View and Slide Over on iPad for the Clinic app.
    requireFullScreen: variant === 'patient',
  },
  android: {
    package: `${idPrefix}.${variant}`,
    // Permissions are added with the features that need them, never ahead of time.
    permissions: [],
  },
  plugins: [
    'expo-router',
    // Only the Clinic app uses biometrics (unlock and signing); the Patient app asks for none.
    ...(variant === 'clinic'
      ? [
          [
            'expo-local-authentication',
            {
              faceIDPermission: 'Face ID unlocks the Clinic app and approves prescription signing.',
            },
          ] as [string, Record<string, string>],
        ]
      : []),
    'expo-notifications',
  ],
  experiments: { typedRoutes: true },
  extra: { variant },
});
