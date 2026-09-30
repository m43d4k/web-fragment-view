import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { verifyAccess } from '../src/worker/auth';

const env = { ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'private-viewer', ALLOWED_EMAIL: 'me@example.test' };
let key: CryptoKey;
let resolver: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' }] });
});

async function token(overrides: {email?: string; aud?: string; exp?: number; issuer?: string} = {}) {
  return new SignJWT({ email: overrides.email ?? env.ALLOWED_EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(overrides.issuer ?? `https://${env.ACCESS_TEAM_DOMAIN}`).setAudience(overrides.aud ?? env.ACCESS_AUD)
    .setSubject('user').setIssuedAt().setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 60).sign(key);
}
const req = (jwt: string) => new Request('https://view.example.test', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });

describe('Access identity', () => {
  it('accepts a signed, unexpired token for the configured app and person', async () => {
    await expect(verifyAccess(req(await token()), env, resolver)).resolves.toBeUndefined();
  });
  it.each([{email:'other@example.test'}, {aud:'different-app'}, {exp:1}, {issuer:'https://wrong.cloudflareaccess.com'}])('rejects %j', async change => {
    await expect(verifyAccess(req(await token(change)), env, resolver)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects tampered signatures and unconfigured production', async () => {
    const jwt = await token();
    const pieces = jwt.split('.');
    pieces[2] = (pieces[2][0] === 'a' ? 'b' : 'a') + pieces[2].slice(1);
    await expect(verifyAccess(req(pieces.join('.')), env, resolver)).rejects.toMatchObject({ status: 401 });
    await expect(verifyAccess(req(jwt), { ...env, ACCESS_AUD: '' }, resolver)).rejects.toMatchObject({ status: 503 });
  });
  it('permits explicit local mode only on a loopback host', async () => {
    await expect(verifyAccess(new Request('http://127.0.0.1:8787'), { ...env, LOCAL_DEV: 'true' })).resolves.toBeUndefined();
    await expect(verifyAccess(new Request('https://view.example.test'), { ...env, LOCAL_DEV: 'true' })).rejects.toMatchObject({ status: 401 });
  });
});
