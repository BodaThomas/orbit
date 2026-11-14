import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'

/** Ed25519 identities for runtimes and Orbit Desktop clients. */
export interface Identity {
  privateKey: KeyObject
  /** SPKI DER, base64. */
  publicKey: string
  fingerprint: string
}

export const fingerprintOf = (publicKeyB64: string): string => `SHA256:${createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('base64').replace(/=+$/, '')}`

export function generateIdentity(): { identity: Identity; privatePem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { identity: { privateKey, publicKey: pub, fingerprint: fingerprintOf(pub) }, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

export function loadIdentity(privatePem: string): Identity {
  const privateKey = createPrivateKey(privatePem)
  const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
  return { privateKey, publicKey: pub, fingerprint: fingerprintOf(pub) }
}

export const signMessage = (id: Identity, message: string): string => sign(null, Buffer.from(message), id.privateKey).toString('base64')

export function verifyMessage(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(message), key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

export const nonce = (): string => randomBytes(24).toString('base64url')
