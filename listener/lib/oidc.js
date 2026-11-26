// Verify a GitHub Actions OIDC token, so only Verity's own workflow on main can ask
// the listener to sign. No shared secret is needed in GitHub.
import { createPublicKey, verify } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
let jwks = null;

export async function verifyGithubToken(token, { audience, repository, ref }) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("malformed token");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  if (!jwks || !jwks.keys.some((k) => k.kid === header.kid)) {
    jwks = await fetch(`${ISSUER}/.well-known/jwks`).then((r) => r.json());
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error("wrong issuer");
  if (claims.aud !== audience) throw new Error("wrong audience");
  if (!(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) throw new Error("expired");
  if (claims.repository !== repository) throw new Error("wrong repository");
  if (claims.ref !== ref) throw new Error("wrong ref");
  return claims;
}
