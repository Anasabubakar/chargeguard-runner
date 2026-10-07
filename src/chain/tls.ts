import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

/**
 * Soroban's JS RPC client refuses plain http:// endpoints unless `allowHttp` is passed, and
 * @stellar/mpp does not expose that option. The stub chain therefore speaks https with a
 * throwaway self-signed certificate for 127.0.0.1, generated per run with the openssl CLI
 * (nothing is committed) and trusted only through NODE_EXTRA_CA_CERTS / setDefaultCACertificates.
 */
export interface TestCert {
  certPath: string;
  keyPath: string;
  cert: string;
  key: string;
}

export function createTestCert(parentDir: string = process.env.CHARGEGUARD_TMPDIR ?? tmpdir()): TestCert {
  const dir = mkdtempSync(join(parentDir, "chargeguard-tls-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-subj", "/CN=chargeguard-fake-chain", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-days", "2"],
    { stdio: "ignore" },
  );
  return { certPath, keyPath, cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

/** Adds the certificate to this process's default trust store (Node >= 24.5). */
export function trustCert(cert: string): void {
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), cert]);
}
