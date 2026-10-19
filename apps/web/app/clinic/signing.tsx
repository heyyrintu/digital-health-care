'use client';

import { Input, Label } from '@dhc/ui-web';
import { useSession } from './session-provider';

/**
 * The 6-digit signing PIN, as every document the doctor signs asks for it (prescriptions,
 * referral letters). Digits only; the hint says where it was set.
 */
export function SigningPinField({
  id,
  value,
  onChange,
}: {
  /** Unique on the page; the hint's ID is derived from it. */
  id: string;
  value: string;
  onChange(pin: string): void;
}) {
  const { t } = useSession();
  return (
    <div className="max-w-56 space-y-1.5">
      <Label htmlFor={id} className="block text-sm font-semibold">
        {t('sign.pin')}
      </Label>
      <Input
        id={id}
        required
        inputMode="numeric"
        autoComplete="off"
        pattern="\d{6}"
        maxLength={6}
        className="tabular tracking-[0.3em]"
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('sign.pinHint')}
      </p>
    </div>
  );
}

/**
 * Opens a PDF the API serves in a new tab. The tab opens first, so the browser does not
 * block it; on a failure it closes again and `onError` gets the error.
 */
export async function openPdf(load: () => Promise<Blob>, onError: (e: unknown) => void) {
  const tab = window.open('', '_blank');
  try {
    const url = URL.createObjectURL(await load());
    if (tab) tab.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    tab?.close();
    onError(e);
  }
}
