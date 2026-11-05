// Redirect to a private env file or copy directly into Coolify. No credentials in git.
import { randomBytes } from 'node:crypto';
const url = new URL(process.argv[2] ?? 'https://preview.example.com');
if (
  url.protocol !== 'https:' ||
  url.pathname !== '/' ||
  url.search ||
  url.hash ||
  url.username ||
  url.password
) {
  throw new Error('Supply a public HTTPS origin, for example https://preview.example.com');
}
console.log(`APP_URL=${url.origin}
RELEASE_TAG=client-preview-1
POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}
REDIS_PASSWORD=${randomBytes(32).toString('hex')}
JWT_SECRET=${randomBytes(48).toString('hex')}
FIELD_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}
COOLIFY_PROXY_CIDR=
PLATFORM_ALLOWED_CIDRS=
PRIVACY_NOTICE_URL=
TERMS_URL=`);
