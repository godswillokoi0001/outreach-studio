"use client";

import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { doc, getDocFromServer, getFirestore } from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";
import {
  clearWorkspaceToken,
  readWorkspaceToken,
  writeWorkspaceToken,
} from "./workspace-token";

export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Sign-in asks only for basic Google identity scopes (openid, email, profile).
// Google blocks unverified apps that request Gmail/Sheets scopes during sign-in,
// so those scopes are requested separately, on demand, by connectWorkspacePopup().
const provider = new GoogleAuthProvider();
provider.setCustomParameters({
  prompt: "select_account",
});

// Gmail + Sheets are requested only when the user presses "Connect Google".
const workspaceProvider = new GoogleAuthProvider();
for (const scope of WORKSPACE_SCOPES) {
  workspaceProvider.addScope(scope);
}
workspaceProvider.setCustomParameters({
  prompt: "consent select_account",
});

// Strictly in-memory Workspace OAuth token (never localStorage or sessionStorage).
let connectionTested = false;

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((p) => ({
          providerId: p.providerId,
          email: p.email,
        })) ?? [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<void> {
  if (connectionTested) return;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

export function subscribeAuthState(onChange: (user: User | null) => void) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) clearWorkspaceToken();
    onChange(user);
  });
}

/** Identity-only sign-in: no Gmail or Sheets scopes, so Google never blocks it. */
export async function signInWithGoogle(): Promise<{ user: User }> {
  const result = await signInWithPopup(auth, provider);
  return { user: result.user };
}

/** Asks Google for the Workspace scopes (Sheets + Gmail) on demand. */
export async function connectWorkspacePopup(): Promise<{ accessToken: string }> {
  const result = await signInWithPopup(auth, workspaceProvider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) {
    throw new Error(
      "Google did not return a Workspace access token. Gmail and Sheets permissions were not granted.",
    );
  }
  writeWorkspaceToken(credential.accessToken);
  return { accessToken: credential.accessToken };
}

export function getWorkspaceAccessToken(): string | null {
  return readWorkspaceToken();
}

export async function getFirebaseIdToken(): Promise<string | null> {
  if (!auth.currentUser) return null;
  return auth.currentUser.getIdToken();
}

export async function logout(): Promise<void> {
  clearWorkspaceToken();
  await auth.signOut();
}
