/**
 * Host services injected into the core so it stays testable outside Electron.
 */
export interface SecretCipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export interface PlatformServices {
  secrets: SecretCipher
  nativeNotify(title: string, body: string, route: string | null): void
  fetch: typeof fetch
}
