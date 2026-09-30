import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAIL: string;
  LOCAL_DEV?: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const resolvers = new Map<string, JWTVerifyGetKey>();

export async function verifyAccess(request: Request, env: AuthEnv, testKey?: JWTVerifyGetKey): Promise<void> {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '') || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED', '認証設定が完了していません。');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'ログインが必要です。');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let resolver = testKey ?? resolvers.get(issuer);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    resolvers.set(issuer, resolver);
  }
  try {
    const { payload } = await jwtVerify(token, resolver, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'] });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
      throw new Error('identity not allowed');
    }
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'ログインを確認できません。再度ログインしてください。');
  }
}
