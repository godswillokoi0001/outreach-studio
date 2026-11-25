import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | Knowrevo",
  description: "How Knowrevo collects, uses, and protects information when you use the service.",
};

const sections = [
  {
    id: "information-we-handle",
    title: "Information we handle",
    paragraphs: [
      "Knowrevo is a workspace for researching prospects and managing email outreach. Depending on the features you use, the service handles account details such as your name, email address, and account identifier; settings and business knowledge you provide; and workspace records such as prospect details, campaign drafts, approved messages, replies, and activity.",
      "If you connect Google, the service requests the Google permissions shown during consent so it can work with your Gmail and Google Sheets. This can include spreadsheet content you choose to import or update, messages and message metadata needed to send approved email and sync replies, and account information used to identify the connected Google account. You can disconnect Google access through your Google Account security settings.",
      "When a recipient loads remote images in an email, a small tracking image may record an open event, the message and prospect identifiers, timestamp, and the recipient mail client’s user-agent string. Image prefetching by mail clients can make open events inaccurate; recipients can prevent this tracking by blocking remote images.",
    ],
  },
  {
    id: "how-we-use-information",
    title: "How information is used",
    paragraphs: [
      "We use information to provide and secure the workspace, research and organize prospects, prepare outreach drafts, send messages you approve, sync replies, maintain suppression and unsubscribe records, and show campaign activity. We may also use operational information to troubleshoot, protect, and improve the service.",
      "AI features process the relevant business knowledge, prospect details, and message context through the AI provider and model configured for your workspace. Do not submit information you do not have the right to use. Provider handling of submitted information is subject to that provider’s terms and privacy practices.",
      "We do not use Google Workspace data for advertising. Google data is used only to provide the features you request, in accordance with the Google API Services User Data Policy, including its Limited Use requirements.",
    ],
  },
  {
    id: "storage-and-providers",
    title: "Storage, security, and service providers",
    paragraphs: [
      "Workspace records are stored in Firebase/Cloud Firestore, and account settings are stored in Supabase. The service uses Vercel for hosting and Google APIs for Google-connected features. These providers process information as needed to provide their services and may store it in locations outside your country.",
      "Google connection credentials are handled by the service to maintain the connection; persistent refresh-token data is encrypted before it is stored in a secure, HTTP-only cookie. We use access controls and other safeguards designed to protect information, but no method of storage or transmission can be guaranteed completely secure.",
    ],
  },
  {
    id: "sharing-and-retention",
    title: "Sharing and retention",
    paragraphs: [
      "We do not sell personal information. We share information with the providers described above when needed to operate the service, when you direct us to (for example, sending an email or updating a sheet), or when disclosure is required to comply with law or protect the service and its users.",
      "Workspace information is retained for as long as needed to provide the service and for legitimate operational, security, and legal purposes. You can ask us about access, correction, or deletion by emailing hello@godswillokoi.site. Some records may remain in backups or be retained where legally required.",
    ],
  },
  {
    id: "your-choices",
    title: "Your choices and responsibilities",
    paragraphs: [
      "You can choose what information to add, which Google account to connect, what messages to approve, and whether to use open tracking in the messages you send. You are responsible for having an appropriate legal basis and providing any notices or choices required for the contacts whose information you upload or email.",
      "You may revoke the app’s Google access at any time in your Google Account. Revoking access can stop Gmail and Sheets features from working until you reconnect.",
    ],
  },
  {
    id: "children-and-changes",
    title: "Children and policy updates",
    paragraphs: [
      "Knowrevo is intended for business use and is not directed to children. We may update this policy as the service changes. The updated date above indicates when the latest version was published; continued use after an update means the updated policy applies to future use.",
    ],
  },
] satisfies Parameters<typeof LegalPage>[0]["sections"];

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      summary="A straightforward account of what Knowrevo handles, why it is needed, and the choices you have."
      sections={sections}
    />
  );
}
