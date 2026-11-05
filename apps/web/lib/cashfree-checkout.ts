type Checkout = {
  checkout(options: { paymentSessionId: string; redirectTarget: '_self' }): Promise<unknown>;
};
type Factory = (options: { mode: 'sandbox' | 'production' }) => Checkout;
let loading: Promise<Factory> | undefined;
/** Only loaded on the isolated pay page after an explicit Pay click. No patient session is used. */
export function loadCashfree(): Promise<Factory> {
  const current = () => (window as Window & { Cashfree?: Factory }).Cashfree;
  if (current()) return Promise.resolve(current()!);
  if (loading) return loading;
  loading = new Promise<Factory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      loading = undefined;
      reject(new Error('Checkout unavailable'));
    };
    const timer = setTimeout(fail, 10_000);
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (current()) resolve(current()!);
      else fail();
    };
    document.head.appendChild(script);
  });
  return loading;
}
