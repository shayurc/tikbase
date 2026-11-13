// Checking that a receipt or notice really came from Apple.
//
// Everything the App Store sends about a purchase is a JWS: three base64url
// parts, signed with ES256, carrying its own certificate chain in the `x5c`
// header. "Signed" means nothing until that chain is walked back to a
// certificate we already trust, so that is what this file does, with
// node:crypto and no dependency:
//
//   1. the chain is exactly leaf, intermediate, root;
//   2. the root is byte-for-byte Apple Root CA - G3, pinned below;
//   3. the intermediate is signed by the root, is a CA, and carries Apple's
//      "Worldwide Developer Relations" marker;
//   4. the leaf is signed by the intermediate and carries Apple's "App Store
//      receipt signing" marker;
//   5. both were valid at the moment of signing;
//   6. the payload is signed by the leaf's key.
//
// Steps 3 and 4 are not decoration. Apple Root CA - G3 also sits above
// certificates Apple issues to ordinary developers. Without the markers, any
// developer could sign a "receipt" with a key Apple gave them for something
// else and it would chain to the same root.
//
// This is the security boundary for giving away Pro. Change it with care and
// keep tests/apple-jws.test.ts passing.

import { X509Certificate, verify as cryptoVerify } from 'node:crypto';

// Downloaded from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// on 2026-11-13. SHA-256 fingerprint
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
// Expires 2039-04-30.
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

// The markers, as the DER bytes of their object identifiers.
//   1.2.840.113635.100.6.2.1   intermediate: Apple Worldwide Developer Relations
//   1.2.840.113635.100.6.11.1  leaf: App Store receipt signing
// node:crypto exposes no way to list a certificate's extensions, so the
// encoded identifier is searched for in the certificate bytes. The sequence
// contains bytes that are not valid text, so it cannot be smuggled in through
// a name field.
const OID_WWDR_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex');
const OID_RECEIPT_SIGNING = Buffer.from('060a2a864886f76364060b01', 'hex');

export const MAX_JWS_LENGTH = 200_000;

export class AppleJwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleJwsError';
  }
}

export interface VerifyOptions {
  /** PEM roots to trust. Tests pass their own; production uses Apple's. */
  trustedRoots?: string[];
  /** Milliseconds. Injectable so tests do not depend on the clock. */
  now?: number;
}

function b64url(part: string): Buffer {
  return Buffer.from(part, 'base64url');
}

function validAt(cert: X509Certificate, when: number): boolean {
  return Date.parse(cert.validFrom) <= when && when <= Date.parse(cert.validTo);
}

/**
 * Verify an App Store JWS and return its payload. Throws AppleJwsError for
 * anything that is not a genuine, intact Apple signature.
 */
export function verifyAppleJws<T = Record<string, unknown>>(jws: unknown, opts: VerifyOptions = {}): T {
  // The cap only exists to refuse absurd input before parsing it. It has to be
  // generous: a server notification carries its own certificate chain plus two
  // nested JWS that each carry the chain again, base64'd a second time, which
  // comes to roughly 28,000 characters. The first version of this line said
  // 20,000 and would have answered 400 to every real notice.
  if (typeof jws !== 'string' || jws.length > MAX_JWS_LENGTH) throw new AppleJwsError('not a JWS');
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new AppleJwsError('not a JWS');

  let header: any;
  let payload: any;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch {
    throw new AppleJwsError('unreadable JWS');
  }
  // Only ES256. Accepting whatever the header names is the classic JWT hole.
  if (header?.alg !== 'ES256') throw new AppleJwsError('unexpected algorithm');
  const x5c = header?.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || x5c.some((c) => typeof c !== 'string')) {
    throw new AppleJwsError('unexpected certificate chain');
  }

  let leaf: X509Certificate, intermediate: X509Certificate, root: X509Certificate;
  try {
    [leaf, intermediate, root] = x5c.map((c: string) => new X509Certificate(Buffer.from(c, 'base64')));
  } catch {
    throw new AppleJwsError('unreadable certificate');
  }

  const trusted = (opts.trustedRoots ?? [APPLE_ROOT_CA_G3_PEM]).map((pem) => new X509Certificate(pem));
  if (!trusted.some((t) => t.raw.equals(root.raw))) throw new AppleJwsError('untrusted root');

  if (!intermediate.verify(root.publicKey) || !intermediate.ca) throw new AppleJwsError('bad intermediate');
  if (!intermediate.raw.includes(OID_WWDR_INTERMEDIATE)) throw new AppleJwsError('intermediate is not Apple WWDR');
  if (!leaf.verify(intermediate.publicKey)) throw new AppleJwsError('bad leaf');
  if (!leaf.raw.includes(OID_RECEIPT_SIGNING)) throw new AppleJwsError('leaf is not a receipt signer');

  // Judge the certificates at the moment Apple signed, not today: a renewal
  // receipt replayed by the app next year is still genuine. The signing time
  // is inside the signed payload, so it cannot be moved without breaking the
  // signature, and a time in the future is refused.
  const now = opts.now ?? Date.now();
  const signedAt = typeof payload?.signedDate === 'number' ? payload.signedDate : now;
  if (signedAt > now + 86_400_000) throw new AppleJwsError('signed in the future');
  if (!validAt(leaf, signedAt) || !validAt(intermediate, signedAt)) {
    throw new AppleJwsError('certificate not valid at signing time');
  }

  const signature = b64url(parts[2]);
  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!ok) throw new AppleJwsError('bad signature');
  return payload as T;
}
