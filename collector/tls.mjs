import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
export function localCertificate(directory, host) {
  if (
    !isIP(host) &&
    !(
      /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) &&
      host.length <= 253
    )
  )
    throw new Error("LAN host must be a plain IP address or DNS hostname");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = resolve(directory, "collector-key.pem"),
    cert = resolve(directory, "collector-cert.pem"),
    identity = resolve(directory, "certificate-host.txt");
  if (existsSync(identity) && readFileSync(identity, "utf8") !== host)
    throw new Error(
      "Certificate belongs to another host; use a new collector directory to re-pair",
    );
  if (!existsSync(key) || !existsSync(cert)) {
    const san = [
      `DNS:localhost`,
      `IP:127.0.0.1`,
      `${isIP(host) ? "IP" : "DNS"}:${host}`,
    ];
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "30",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=HTTP Sequence Logger development collector",
        "-addext",
        `subjectAltName=${[...new Set(san)].join(",")}`,
        "-addext",
        "basicConstraints=critical,CA:FALSE",
        "-addext",
        "extendedKeyUsage=serverAuth",
      ],
      { stdio: "pipe" },
    );
    chmodSync(key, 0o600);
    writeFileSync(identity, host, { mode: 0o600 });
  }
  return { key, cert, host };
}
