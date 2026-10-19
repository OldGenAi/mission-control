// Run with: npm test   (Node's built-in test runner, no extra dependencies, no network needed)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { guardedFetch, guardedLookup, isBlockedHost, isPrivateAddress } from '../src/tools/ssrf-guard.js'

// Every host as the URL parser hands it to the tool (brackets kept for IPv6, numbers normalised).
const hostOf = (url: string): string => new URL(url).hostname

test('private and reserved IPv4 addresses are blocked', () => {
  for (const ip of [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254',
    '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.168.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`)
  }
})

test('public IPv4 addresses are allowed, including the edges of private ranges', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.254']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`)
  }
})

test('IPv6 addresses that wrap a private IPv4 address are blocked in every spelling', () => {
  for (const ip of [
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:192.168.1.1', '::ffff:c0a8:101', '::ffff:10.0.0.1',
    '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
    'fe80::1', 'fe80::1%eth0', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '2001::1', '2001:db8::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`)
  }
})

test('public IPv6 addresses are allowed', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '2002:808:808::1', '64:ff9b::808:808']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`)
  }
})

test('text that is not a valid IP literal is treated as blocked', () => {
  for (const junk of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1:2:3', ':::', '12345::1']) {
    assert.equal(isPrivateAddress(junk), true, `"${junk}" should fail closed`)
  }
})

test('the hostnames the URL parser produces for disguised loopback addresses are blocked', () => {
  for (const url of [
    'http://127.0.0.1:4747/', 'http://127.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://017700000001/',
    'http://[::1]:4747/', 'http://[::ffff:127.0.0.1]:4747/', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
    'http://[::127.0.0.1]/', 'http://[::ffff:192.168.1.1]/', 'http://0.0.0.0/', 'http://[fe80::1]/',
  ]) {
    assert.equal(isBlockedHost(hostOf(url)), true, `${url} should be blocked`)
  }
})

test('internal-by-definition names are blocked, ordinary public names pass the up-front check', () => {
  for (const name of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'metadata.google.internal', 'intranet', 'host.localdomain']) {
    assert.equal(isBlockedHost(name), true, `${name} should be blocked`)
  }
  for (const name of ['example.com', 'api.search.brave.com', 'sub.domain.co.uk', '8.8.8.8']) {
    assert.equal(isBlockedHost(name), false, `${name} should pass the up-front check`)
  }
})

test('connect-time lookup refuses a name that resolves to a loopback address', async () => {
  // "localhost" resolves through the hosts file, so this needs no network. It stands in for any
  // public-looking name (localtest.me, a rebinding domain) that points at an internal address.
  await assert.rejects(
    new Promise((resolve, reject) => {
      guardedLookup('localhost', {}, (err, address) => (err ? reject(err) : resolve(address)))
    }),
    (err: NodeJS.ErrnoException) => err.code === 'ESSRF' && /SSRF protection/.test(err.message),
  )
})

test('guardedFetch never reaches a loopback server, however the address is written', async () => {
  let hits = 0
  const server = http.createServer((_req, res) => { hits++; res.end('internal service reached') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const opts = { method: 'GET' as const, headers: {}, timeoutMs: 3000, maxBytes: 1024 }
  try {
    for (const url of [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      `http://[::ffff:7f00:1]:${port}/`,
      `http://2130706433:${port}/`,
    ]) {
      await assert.rejects(guardedFetch(url, opts), /SSRF protection/, `${url} should be refused`)
    }
    assert.equal(hits, 0, 'the internal server must never see a request')
  } finally {
    server.close()
  }
})

test('guardedFetch refuses non-http protocols and cloud metadata addresses', async () => {
  const opts = { method: 'GET' as const, headers: {}, timeoutMs: 3000, maxBytes: 1024 }
  await assert.rejects(guardedFetch('file:///etc/passwd', opts), /not allowed/)
  await assert.rejects(guardedFetch('ftp://example.com/x', opts), /not allowed/)
  await assert.rejects(guardedFetch('http://169.254.169.254/latest/meta-data/', opts), /SSRF protection/)
  await assert.rejects(guardedFetch('http://[::ffff:a9fe:a9fe]/latest/meta-data/', opts), /SSRF protection/)
})
