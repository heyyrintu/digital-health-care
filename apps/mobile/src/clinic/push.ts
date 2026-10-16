import { PushDevice } from '@dhc/contracts';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from '../api';

/**
 * Registers this device for push notifications under the signed-in session
 * (`POST /push-devices`). Best effort: a refused permission, a simulator or a build without
 * an EAS project simply means no pushes; the app works the same.
 */
export async function registerForPush(deviceName: string | null): Promise<void> {
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return;
  try {
    // Shown while the app is open too, not only in the background.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Clinic',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return;
    const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.request('POST', '/push-devices', {
      schema: PushDevice,
      body: {
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVariant: 'clinic',
        expoPushToken,
        deviceName,
      },
    });
  } catch {
    // Retried on the next launch.
  }
}
