import { cn } from '@dhc/ui-web';

/**
 * A clinic's logo (Build Plan §5.1 branding): a plain image from the API's public logo
 * route, which serves only verified PNG, JPEG or WebP bytes with `nosniff`. Not next/image,
 * which would fetch it through the web server. Decorative: the clinic's name is always
 * shown beside it.
 */
export function BrandLogo({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      // The address is a content hash: no referrer is needed to serve it.
      referrerPolicy="no-referrer"
      decoding="async"
      className={cn('w-auto shrink-0 object-contain', className)}
      data-testid="clinic-logo"
    />
  );
}
