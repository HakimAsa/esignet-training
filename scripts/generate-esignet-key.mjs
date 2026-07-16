#!/usr/bin/env node
/**
 * Generates the RSA key pair used to authenticate this app as an OIDC client
 * to eSignet (the "private_key_jwt" client assertion — see
 * src/services/esignet.service.ts).
 *
 * Produces:
 *  - a PKCS8 private key + kid, printed so you can paste them into .env as
 *    ESIGNET_PRIVATE_KEY / ESIGNET_KEY_ID (never written to disk directly —
 *    you decide where the private key ends up)
 *  - a public JWK written to esignet-public-jwk.json, which is what gets
 *    shared with the MOSIP/eSignet team to register this client
 *
 * Usage:
 *   node scripts/generate-esignet-key.mjs
 *
 * Re-run this to rotate the key: generate a new pair, send the new JWK to
 * MOSIP, then swap ESIGNET_PRIVATE_KEY/ESIGNET_KEY_ID in .env once they
 * confirm the new key is registered. Don't overwrite the old one in .env
 * until then, or the running app will sign assertions with a kid MOSIP
 * doesn't recognize yet.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const ALG = "RS256";
const MODULUS_LENGTH = 2048;
const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../esignet-public-jwk.json");

const { privateKey, publicKey } = await generateKeyPair(ALG, {
  modulusLength: MODULUS_LENGTH,
  extractable: true,
});

const kid = randomUUID();
const privatePkcs8 = await exportPKCS8(privateKey);
const publicJwk = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: ALG };

await writeFile(OUTPUT_PATH, `${JSON.stringify(publicJwk, null, 2)}\n`);

console.log(`Public JWK written to ${path.relative(process.cwd(), OUTPUT_PATH)} — send this file to the MOSIP/eSignet team.\n`);

console.log("Paste these into .env:\n");
console.log(`ESIGNET_KEY_ID=${kid}`);
console.log(`ESIGNET_PRIVATE_KEY="${privatePkcs8.trim()}"`);
