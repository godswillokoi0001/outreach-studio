"use client";

import { ArrowUpRight } from "lucide-react";

import { useAuth } from "./AuthProvider";
import { Banner } from "./ui";

/**
 * Google refuses the Gmail/Sheets consent for an app that is not verified
 * unless the account is a test user. That switch lives in Google Cloud, so the
 * notice names the exact page instead of leaving the failure invisible.
 */
export function WorkspaceIssueNotice() {
  const { user, workspaceIssue, clearWorkspaceIssue } = useAuth();
  if (!workspaceIssue) return null;

  const audienceUrl = `https://console.cloud.google.com/auth/audience`;
  const apisUrl = `https://console.cloud.google.com/apis/dashboard`;
  const email = user.email ?? "your Google account";
  const blocked = workspaceIssue.kind === "verification";

  return (
    <Banner tone={blocked ? "warn" : "bad"}>
      <div style={{ display: "grid", gap: 8, minWidth: 0, flex: 1 }}>
        <strong>
          {blocked
            ? "Google is blocking Gmail and Sheets access — it takes two clicks to unblock"
            : "Google connection failed"}
        </strong>
        <span>{workspaceIssue.message}</span>

        {blocked && (
          <>
            <span>
              Google only allows the Gmail and Sheets scopes for a verified app, or for accounts listed as
              test users while the app is in testing. Do this with the same account you sign in with (
              <strong>{email}</strong>):
            </span>
            <ol className="setup-steps" style={{ margin: 0 }}>
              <li>
                Open{" "}
                <a href={audienceUrl} target="_blank" rel="noreferrer">
                  Google Auth Platform → Audience
                </a>{" "}
                and check the publishing status is <strong>Testing</strong>. If it says “In production”,
                switch it back to testing.
              </li>
              <li>
                On that same page, under <strong>Test users</strong>, click <strong>Add users</strong> and add{" "}
                <strong>{email}</strong>.
              </li>
              <li>
                In{" "}
                <a href={apisUrl} target="_blank" rel="noreferrer">
                  APIs &amp; Services
                </a>
                , confirm <strong>Gmail API</strong> and <strong>Google Sheets API</strong> are enabled for
                the Google Cloud project that owns your OAuth client.
              </li>
              <li>Come back here and press “Connect Google” again.</li>
            </ol>
            <span className="tiny">
              A published app that is not verified cannot use Gmail’s restricted scopes without Google’s
              review, and restricted scopes also require a paid CASA security assessment — which is why
              test users is the practical route.
            </span>
          </>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {blocked && (
            <a className="btn btn-sm" href={audienceUrl} target="_blank" rel="noreferrer">
              <span>Open Google Auth Platform</span>
              <ArrowUpRight size={13} />
            </a>
          )}
          <button className="btn btn-sm btn-ghost" type="button" onClick={clearWorkspaceIssue}>
            Dismiss
          </button>
        </div>
      </div>
    </Banner>
  );
}
