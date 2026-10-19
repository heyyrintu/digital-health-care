'use client';

import { ApiError, createApiClient } from '@dhc/api-client';
import type { PublicBranding } from '@dhc/contracts';
import { useEffect, useMemo, useState } from 'react';
import { isClinicSlug } from '../../lib/patient';
import { usePatientSession } from './session-provider';

/**
 * A clinic's saved branding for the portal's sign-in and frame (Build Plan §5.1), from the
 * public `GET /v1/public/organisations/{slug}/branding`: sent without the patient's token,
 * cached a minute by the browser. Null while it loads, for a clinic with no branding (404),
 * for an address that is not a clinic ID, or when the API cannot be reached: the portal
 * then keeps the platform look, and sign-in works the same either way.
 */
export function usePublicBranding(slug: string | null | undefined): PublicBranding | null {
  const { apiBaseUrl } = usePatientSession();
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const wanted = slug && isClinicSlug(slug) ? slug : null;
  const [loaded, setLoaded] = useState<{ slug: string; branding: PublicBranding | null } | null>(
    null,
  );

  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    api.publicBranding(wanted, { signal: controller.signal }).then(
      (branding) => setLoaded({ slug: wanted, branding }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        if (!(e instanceof ApiError && e.status === 404)) {
          console.warn('Clinic branding unavailable:', e instanceof ApiError ? e.status : e);
        }
        setLoaded({ slug: wanted, branding: null });
      },
    );
    return () => controller.abort();
  }, [api, wanted]);

  return wanted && loaded?.slug === wanted ? loaded.branding : null;
}
