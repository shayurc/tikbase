// Test-only: builds a certificate chain shaped like Apple's (root, a WWDR-like
// intermediate, a receipt-signing leaf) and signs JWS with it, so the verifier
// can be exercised without Apple. Uses the openssl command line because Node
// cannot mint certificates. Keys are made fresh in a temp folder on every run;
// nothing here is a secret and nothing is committed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';

export const OID_INTERMEDIATE = '1.2.840.113635.100.6.2.1';
export const OID_LEAF = '1.2.840.113635.100.6.11.1';

export interface Chain {
  rootPem: string;
  /** base64 DER, leaf first: the JWS `x5c` header. */
  x5c: string[];
  leafKeyPem: string;
}

function der(pem: string): string {
  return pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
}

export function makeChain(opts: { intermediateOid?: boolean; leafOid?: boolean } = {}): Chain {
  const dir = mkdtempSync(join(tmpdir(), 'apple-chain-'));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(
    join(dir, 'openssl.cnf'),
    [
      '[req]',
      'distinguished_name=dn',
      'prompt=no',
      'x509_extensions=v3_root',
      '[dn]',
      'CN=Test',
      '[v3_root]',
      'basicConstraints=critical,CA:TRUE',
      '[v3_int]',
      'basicConstraints=critical,CA:TRUE',
      ...(opts.intermediateOid === false ? [] : [`${OID_INTERMEDIATE}=DER:0500`]),
      '[v3_leaf]',
      'basicConstraints=CA:FALSE',
      ...(opts.leafOid === false ? [] : [`${OID_LEAF}=DER:0500`]),
      '',
    ].join('\n'),
  );
  for (const name of ['root', 'int', 'leaf']) {
    run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.ec.key`);
    run('pkcs8', '-topk8', '-nocrypt', '-in', `${name}.ec.key`, '-out', `${name}.key`);
  }
  run('req', '-x509', '-new', '-key', 'root.key', '-sha256', '-days', '3650', '-config', 'openssl.cnf', '-subj', '/CN=Test Root', '-out', 'root.pem');
  run('req', '-new', '-key', 'int.key', '-config', 'openssl.cnf', '-subj', '/CN=Test Intermediate', '-out', 'int.csr');
  run('x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '3650', '-sha256', '-extfile', 'openssl.cnf', '-extensions', 'v3_int', '-out', 'int.pem');
  run('req', '-new', '-key', 'leaf.key', '-config', 'openssl.cnf', '-subj', '/CN=Test Leaf', '-out', 'leaf.csr');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '3650', '-sha256', '-extfile', 'openssl.cnf', '-extensions', 'v3_leaf', '-out', 'leaf.pem');
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return {
    rootPem: read('root.pem'),
    x5c: [der(read('leaf.pem')), der(read('int.pem')), der(read('root.pem'))],
    leafKeyPem: read('leaf.key'),
  };
}

export function signJws(
  chain: Chain,
  payload: Record<string, unknown>,
  opts: { alg?: string; x5c?: string[]; keyPem?: string } = {},
): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: opts.alg ?? 'ES256', x5c: opts.x5c ?? chain.x5c });
  const body = enc(payload);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(opts.keyPem ?? chain.leafKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${head}.${body}.${sig.toString('base64url')}`;
}
