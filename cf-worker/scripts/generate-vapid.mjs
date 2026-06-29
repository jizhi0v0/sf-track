import { createECDH } from "node:crypto";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();

console.log(`VAPID_PUBLIC_KEY=${base64Url(ecdh.getPublicKey())}`);
console.log(`VAPID_PRIVATE_KEY=${base64Url(ecdh.getPrivateKey())}`);
