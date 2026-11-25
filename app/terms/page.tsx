import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service | Knowrevo",
  description: "Terms governing your use of Knowrevo for prospect research and email outreach.",
};

const sections = [
  {
    id: "accepting-terms",
    title: "Accepting these terms",
    paragraphs: [
      "These Terms of Service apply when you access or use Knowrevo. By using the service, you agree to these terms. If you use it for a business or other organization, you confirm that you are authorized to accept these terms on its behalf.",
    ],
  },
  {
    id: "using-the-service",
    title: "Using the service",
    paragraphs: [
      "Knowrevo provides tools for managing prospect information, researching businesses, preparing outreach, connecting Google services, and reviewing campaign activity. You must provide accurate account information, protect access to your account, and use the service only as permitted by applicable law and these terms.",
      "You are responsible for the information you submit, the Google account and other integrations you connect, and the messages you approve or send. Keep your credentials secure and promptly contact us if you believe your account has been used without permission.",
    ],
  },
  {
    id: "email-and-compliance",
    title: "Email, consent, and compliance",
    paragraphs: [
      "You are solely responsible for ensuring that your prospect research and communications comply with applicable privacy, marketing, anti-spam, consumer-protection, and email laws, including requirements that apply where you and your recipients are located. This includes obtaining any required permissions, identifying yourself accurately, providing required notices and opt-out methods, honoring opt-outs, and keeping suppression lists up to date.",
      "Do not use the service to send unsolicited or unlawful messages, mislead recipients, evade sending limits or spam controls, or contact people who have opted out. You must respect Google’s terms, API policies, and usage limits. We may limit or suspend access when we reasonably believe use creates legal, security, or provider-policy risk.",
    ],
  },
  {
    id: "ai-and-research",
    title: "AI output and research",
    paragraphs: [
      "Research, classifications, and message drafts may be produced with automated systems and can be incomplete, outdated, or incorrect. They are suggestions, not legal, business, or professional advice. You must review and verify facts, recipients, and message content before use. Unless you enable an automation feature, messages require your approval before sending; any automation settings you choose remain your responsibility.",
    ],
  },
  {
    id: "your-content",
    title: "Your content and permissions",
    paragraphs: [
      "You retain your rights to the information and materials you submit. You grant us permission to host, process, transmit, and display that content only as reasonably necessary to operate, secure, and provide the service and the features you choose. You confirm that you have the rights and permissions needed to provide the content and direct us to process it.",
    ],
  },
  {
    id: "availability-and-liability",
    title: "Availability and disclaimers",
    paragraphs: [
      "The service is provided on an “as available” basis. We do not guarantee uninterrupted availability, delivery of any email, inbox placement, recipient engagement, accuracy of third-party data, or any particular sales result. Google and other providers may change or limit their services, which can affect Knowrevo features.",
      "To the extent permitted by law, Knowrevo is provided without warranties of any kind, express or implied. Nothing in these terms excludes a right or liability that cannot legally be excluded.",
    ],
  },
  {
    id: "suspension-and-changes",
    title: "Suspension, termination, and changes",
    paragraphs: [
      "You may stop using the service at any time and revoke connected Google access through your Google Account. We may suspend or terminate access if necessary to protect users, comply with law, address misuse, or respond to a provider restriction. We may update these terms as the service evolves; the updated date above identifies the current version. Continued use after an update means you accept the revised terms.",
    ],
  },
  {
    id: "contact",
    title: "Contact",
    paragraphs: [
      "Questions about these terms can be sent to hello@godswillokoi.site.",
    ],
  },
] satisfies Parameters<typeof LegalPage>[0]["sections"];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      summary="The responsibilities and ground rules for using Knowrevo to manage prospecting and outreach."
      sections={sections}
    />
  );
}
