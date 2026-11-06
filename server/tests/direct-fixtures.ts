import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { desktopFixture } from './desktop-fixtures.ts';

export const directBase = '/v1/desktop-pdfs';
// Reserved documentation addresses only; these strings never reach a peer.
export const directOffer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:synthetic\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ host\r\na=sctp-port:5000\r\n';
export const directAnswer = directOffer.replace('o=- 1 1', 'o=- 2 2');
export type DirectFixture = ReturnType<typeof desktopFixture>;
export function control(app: FastifyInstance, f: DirectFixture, id: string, action = '', who = 'consumer', body: Record<string, unknown> = {}) {
  return app.inject({ method: action ? 'POST' : 'GET', url: directBase + '/requests/' + id + '/direct' + (action ? '/' + action : ''),
    headers: f.headers(who), ...(action ? { payload: body } : {}) });
}
export async function directOnline(app: FastifyInstance, f: DirectFixture, direct = true, who = 'provider') {
  const result = await app.inject({ method: 'POST', url: directBase + '/provider/poll', headers: f.headers(who), payload: direct ? { direct: true } : {} });
  assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json(), { request: null });
}
export function directCreate(app: FastifyInstance, f: DirectFixture, offer: string | undefined = directOffer) {
  return app.inject({ method: 'POST', url: directBase + '/requests', headers: f.headers(),
    payload: { attachmentVersionId: f.target.version.entityId, ...(offer === undefined ? {} : { direct: { offer } }) } });
}
export async function directAssigned(app: FastifyInstance, f: DirectFixture) {
  const created = await directCreate(app, f); assert.equal(created.statusCode, 201, created.body);
  const polled = await app.inject({ method: 'POST', url: directBase + '/provider/poll', headers: f.headers('provider'), payload: { direct: true } });
  assert.equal(polled.statusCode, 200, polled.body); assert.equal(polled.json().request?.requestId, created.json().requestId);
  assert.equal(polled.json().request.direct.offer, directOffer);
  return { id: created.json().requestId as string, created: created.json(), job: polled.json().request };
}
export function completion(f: DirectFixture) { return { sha256: f.target.version.data.sha256, sizeBytes: f.target.version.data.sizeBytes }; }
export async function finalAuthorized(app: FastifyInstance, f: DirectFixture, id: string) {
  assert.equal((await control(app, f, id, 'answer', 'provider', { sdp: directAnswer })).statusCode, 200);
  const authorized = await control(app, f, id, 'authorize', 'provider');
  assert.equal(authorized.statusCode, 200, authorized.body); return authorized.json() as { authorizedUntil: string };
}
