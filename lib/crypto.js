/**
 * Relay transport encryption — extension side (Web Crypto API).
 *
 * Scheme:
 *   1. Extension generates a random AES-256 session key
 *   2. Extension encrypts the session key with the embedded RSA public key (RSA-OAEP/SHA-256)
 *   3. Encrypted session key is sent in Extension.hello
 *   4. All subsequent messages are encrypted with AES-256-GCM
 *
 * Wire format for encrypted messages:
 *   "E:" + base64( IV(12) || ciphertext || authTag(16) )
 */

const ENCRYPTED_PREFIX = 'E:'

// btoa(String.fromCharCode(...spread)) hits call-stack limits on large buffers.
// Process in 8 KB chunks to safely handle CDP payloads like screenshots.
function uint8ToBase64(bytes) {
  const chunks = []
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)))
  }
  return btoa(chunks.join(''))
}

// RSA-2048 public key (SPKI PEM) — paired with the private key in the desktop app.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqWLk0FvFV+hcC3cRkXbY
vOCfjYxBZ8q4oOWrDMiuW1gQfSM4+L/c6ItLE8JQyKe0xkjfwmIZqW3DQ0jnRZ7q
B9NIzuXXdJci2USc26Yt69ThSqGd6wai2QTmJ9MXQlH/n61RRUkzessAQ99VQCT0
2FuvK4mZmkfUhQYlSjtf25Welo5NZK4qaZiupBauBKEpVlhvlDR9HL5DT9zDjU9I
qhKM5IfDMB4BYV82s5r7O8lSz+TFs0qlkAdFQ8ZPF6B6z+bXiM506c5Dw6K7dntA
DiQGbX7TvolimGuQBrBzzXIWl3dAi2dvzU/cK+j8voFcVxsGOhn5NmPmiogw74f5
ZwIDAQAB
-----END PUBLIC KEY-----`

/** @type {CryptoKey|null} */
let _publicKey = null

/** @type {CryptoKey|null} */
let _sessionKey = null

/** Whether encryption has been negotiated for the current connection. */
let _encryptionActive = false

/**
 * Import the embedded RSA public key for RSA-OAEP encryption.
 * Cached after first call.
 */
async function getPublicKey() {
  if (_publicKey) return _publicKey
  const pemBody = PUBLIC_KEY_PEM
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s/g, '')
  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0))
  _publicKey = await crypto.subtle.importKey(
    'spki',
    binaryDer.buffer,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
  return _publicKey
}

/**
 * Generate a fresh AES-256-GCM session key and encrypt it with the RSA public key.
 * Returns { sessionKey, encryptedSessionKey } where encryptedSessionKey is base64-encoded.
 */
export async function prepareSessionKey() {
  const pubKey = await getPublicKey()
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed to encrypt with RSA
    ['encrypt', 'decrypt'],
  )
  const rawKey = await crypto.subtle.exportKey('raw', aesKey)
  const encryptedRaw = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, rawKey)
  const encryptedBase64 = uint8ToBase64(new Uint8Array(encryptedRaw))
  _sessionKey = aesKey
  return { sessionKey: aesKey, encryptedSessionKey: encryptedBase64 }
}

/** Activate encryption for the current connection (called after helloAck confirms). */
export function activateEncryption() {
  if (!_sessionKey) throw new Error('No session key — call prepareSessionKey() first')
  _encryptionActive = true
}

/** Reset encryption state (call on disconnect). */
export function resetEncryption() {
  _sessionKey = null
  _encryptionActive = false
}

/** Whether encryption is active for the current connection. */
export function isEncryptionActive() {
  return _encryptionActive
}

/**
 * Encrypt a plaintext message string using AES-256-GCM.
 * Returns wire-format: "E:" + base64(IV || ciphertext || authTag).
 * If encryption is not active, returns the original string unchanged.
 */
export async function encryptMessage(plaintext) {
  if (!_encryptionActive || !_sessionKey) return plaintext
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _sessionKey, encoded)
  const result = new Uint8Array(iv.length + cipherBuf.byteLength)
  result.set(iv)
  result.set(new Uint8Array(cipherBuf), iv.length)
  return ENCRYPTED_PREFIX + uint8ToBase64(result)
}

/**
 * Decrypt a wire-format encrypted message.
 * If the message doesn't start with "E:" prefix, returns it unchanged (plaintext fallback).
 */
export async function decryptMessage(wireMessage) {
  if (typeof wireMessage !== 'string' || !wireMessage.startsWith(ENCRYPTED_PREFIX) || !_sessionKey) return wireMessage
  const base64Data = wireMessage.slice(ENCRYPTED_PREFIX.length)
  const data = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0))
  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12) // AES-GCM in WebCrypto includes the tag in the ciphertext
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _sessionKey, ciphertext)
  return new TextDecoder().decode(decrypted)
}

/** Check if a raw WebSocket message is in encrypted wire format. */
export function isEncryptedWireMessage(text) {
  return typeof text === 'string' && text.startsWith(ENCRYPTED_PREFIX)
}
