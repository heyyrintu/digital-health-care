'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

/** The day list became the queue; old links keep working. */
export default function AppointmentsPage() {
  return (
    <Suspense>
      <ToQueue />
    </Suspense>
  );
}

function ToQueue() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    router.replace(`/clinic/queue${params.size > 0 ? `?${params.toString()}` : ''}`);
  }, [router, params]);
  return null;
}
