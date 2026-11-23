import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextRequest } from "next/server";
import firebaseConfig from "../firebase-applet-config.json";

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  name: string;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export async function verifyFirebaseRequest(req: NextRequest): Promise<VerifiedFirebaseUser> {
  const explicitHeader = req.headers.get("X-Firebase-Token");
  const authHeader = req.headers.get("Authorization");
  const rawToken =
    explicitHeader?.trim() ||
    (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "");

  if (!rawToken) {
    throw new AuthError("Authentication required. Sign in with Google to continue.", 401);
  }

  try {
    const projectId = firebaseConfig.projectId;
    const { payload } = await jwtVerify(rawToken, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    const uid = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    const emailVerified = payload.email_verified === true;
    const name = typeof payload.name === "string" ? payload.name : email;

    if (!uid || !email || !emailVerified) {
      throw new AuthError("Verified Google account required.", 401);
    }
    return { uid, email, name };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired Firebase session token. Refresh and sign in again.", 401);
  }
}
