// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkMediaLink, checkPictureLink, issueMediaLink, issuePictureLink, MEDIA_LINK_TTL_SEC } from '../src/video/media-links.js'

const SECRET = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const ID = '0123456789abcdef0123456789abcdef'
const NOW = 1_800_000_000_000

function parts(link: string): { id: string; e: string; s: string } {
  const url = new URL(link, 'http://127.0.0.1')
  return { id: url.pathname.split('/').pop()!, e: url.searchParams.get('e')!, s: url.searchParams.get('s')! }
}

test('a fresh link checks out for its own id', () => {
  const { id, e, s } = parts(issueMediaLink(SECRET, ID, NOW))
  assert.equal(id, ID)
  assert.equal(checkMediaLink(SECRET, id, e, s, NOW + 1000), true)
})

test('a link stops working when it expires', () => {
  const { id, e, s } = parts(issueMediaLink(SECRET, ID, NOW))
  assert.equal(checkMediaLink(SECRET, id, e, s, NOW + MEDIA_LINK_TTL_SEC * 1000 - 1), true)
  assert.equal(checkMediaLink(SECRET, id, e, s, NOW + MEDIA_LINK_TTL_SEC * 1000), false)
})

test('a link is tied to one video and one secret', () => {
  const { e, s } = parts(issueMediaLink(SECRET, ID, NOW))
  assert.equal(checkMediaLink(SECRET, 'f'.repeat(32), e, s, NOW), false)
  assert.equal(checkMediaLink(OTHER, ID, e, s, NOW), false, 'a rotated secret kills old links')
})

test('changing the expiry breaks the signature, and far-future expiries are refused', () => {
  const { id, e, s } = parts(issueMediaLink(SECRET, ID, NOW))
  assert.equal(checkMediaLink(SECRET, id, String(Number(e) + 60), s, NOW), false)
  assert.equal(checkMediaLink(SECRET, id, '99999999999', s, NOW), false)
})

test('malformed parts are refused without throwing', () => {
  const { e, s } = parts(issueMediaLink(SECRET, ID, NOW))
  for (const [id, exp, sig] of [
    ['../../etc/passwd', e, s], [ID.toUpperCase(), e, s], [ID, '-1', s], [ID, '1e9', s],
    [ID, e, s.slice(2)], [ID, e, 'zz' + s.slice(2)], [undefined, e, s], [ID, undefined, s], [ID, e, undefined],
    [ID, [e], s],
  ]) {
    assert.equal(checkMediaLink(SECRET, id, exp, sig, NOW), false)
  }
})

test('only video ids can be signed', () => {
  assert.throws(() => issueMediaLink(SECRET, '../x', NOW))
})

test('a picture link opens only a picture, and a video link only a video', () => {
  assert.match(issuePictureLink(SECRET, ID, NOW), /^\/media\/picture\/[0-9a-f]{32}\?e=\d+&s=[0-9a-f]{64}$/)
  const picture = parts(issuePictureLink(SECRET, ID, NOW))
  assert.equal(checkPictureLink(SECRET, picture.id, picture.e, picture.s, NOW), true)
  assert.equal(checkMediaLink(SECRET, picture.id, picture.e, picture.s, NOW), false)
  const video = parts(issueMediaLink(SECRET, ID, NOW))
  assert.equal(checkPictureLink(SECRET, video.id, video.e, video.s, NOW), false)
  assert.equal(checkPictureLink(SECRET, picture.id, picture.e, picture.s, NOW + MEDIA_LINK_TTL_SEC * 1000), false)
  assert.equal(checkPictureLink(SECRET, '../x', picture.e, picture.s, NOW), false)
})
