export type OutreachRegionCode = "US" | "UK" | "EU" | "CA" | "NG" | "INTL";

export interface RegionalComplianceReport {
  region: OutreachRegionCode;
  frameworkName: string;
  requirements: string[];
  b2bPermittedRules: string[];
  cautionNotes: string[];
  footerRequirement: string;
}

const EU_COUNTRY_HINTS =
  /\b(germany|france|spain|italy|netherlands|belgium|austria|poland|sweden|denmark|finland|norway|ireland|portugal|greece|czech|hungary|romania|europe|eu|berlin|paris|amsterdam|madrid|rome|dublin)\b/i;

export function detectOutreachRegion(locationHint: string): OutreachRegionCode {
  const loc = locationHint.trim();
  if (!loc) return "INTL";
  if (/\b(united states|usa|u\.s\.|austin|new york|texas|california|florida|chicago|dallas|atlanta|seattle|miami|boston|los angeles|denver)\b/i.test(loc)) {
    return "US";
  }
  if (/\b(united kingdom|uk|england|scotland|wales|london|manchester|birmingham|leeds|bristol)\b/i.test(loc)) {
    return "UK";
  }
  if (/\b(canada|toronto|vancouver|montreal|calgary|ottawa|ontario|quebec)\b/i.test(loc)) {
    return "CA";
  }
  if (/\b(nigeria|lagos|abuja|port harcourt|ibadan|kano)\b/i.test(loc)) {
    return "NG";
  }
  if (EU_COUNTRY_HINTS.test(loc)) {
    return "EU";
  }
  return "INTL";
}

export function getRegionalComplianceGuidance(input: {
  targetLocation?: string;
  senderLocation?: string;
  physicalAddress?: string;
}): RegionalComplianceReport {
  const combined = `${input.targetLocation ?? ""} ${input.senderLocation ?? ""}`.trim();
  const region = detectOutreachRegion(combined);
  const hasAddress = Boolean((input.physicalAddress ?? "").trim());

  switch (region) {
    case "US":
      return {
        region: "US",
        frameworkName: "US CAN-SPAM Act",
        requirements: [
          "Use accurate From/Reply-To headers and honest sender identity",
          "Avoid deceptive or misleading subject lines (no fake Re:/Fwd: prefixes)",
          "Include a clear, zero-friction opt-out notice and honor unsubscribes immediately",
          hasAddress
            ? "Sender business physical postal address verified in Settings"
            : "Add your physical business postal address in Settings before sending",
        ],
        b2bPermittedRules: [
          "Cold B2B outreach without prior opt-in is lawful provided it is truthful and honors opt-outs.",
        ],
        cautionNotes: [
          "Never buy scraped consumer/personal lists; stick to published business contacts.",
        ],
        footerRequirement: "Include business physical address and plain-text unsubscribe/opt-out line.",
      };

    case "UK":
      return {
        region: "UK",
        frameworkName: "UK PECR & UK GDPR",
        requirements: [
          "Corporate subscribers (Ltd/LLP work addresses) may be contacted under legitimate interest if directly relevant to their business role",
          "Do NOT send unsolicited outreach to sole traders or unverified personal Gmail/Yahoo inboxes under PECR",
          "Provide transparent identity and immediate one-reply / link opt-out",
        ],
        b2bPermittedRules: [
          "Target published corporate domains and relevant decision-maker roles cleanly.",
        ],
        cautionNotes: [
          "Skip sole traders and personal email providers unless explicit prior consent is recorded.",
        ],
        footerRequirement: "State sender identity, relevant B2B context, and instant opt-out option.",
      };

    case "EU":
      return {
        region: "EU",
        frameworkName: "EU GDPR & ePrivacy Directive",
        requirements: [
          "Rely strictly on clear B2B Legitimate Interest aligned to the recipient's professional role",
          "Practice strict data minimization (store only public business work contact details needed for outreach)",
          "Honour erasure/opt-out requests immediately across the global suppression list",
        ],
        b2bPermittedRules: [
          "B2B relevance and minimal personal data processing are mandatory under GDPR Article 6(1)(f).",
        ],
        cautionNotes: [
          "Germany and several EU member states strictly require prior express consent (UWG § 7) for cold electronic marketing — verify local rule before mass sending.",
        ],
        footerRequirement: "Clear sender business details, legitimate business context, and opt-out instruction.",
      };

    case "CA":
      return {
        region: "CA",
        frameworkName: "Canada CASL (Anti-Spam Legislation)",
        requirements: [
          "Only rely on CASL Conspicuous Publication implied consent where the business address was publicly listed without a 'no unsolicited messages' notice AND the offer directly relates to their official business role",
          "Include clear sender identification + physical postal address + working unsubscribe mechanism",
        ],
        b2bPermittedRules: [
          "Keep documented source URL & date proving the email was conspicuously published.",
        ],
        cautionNotes: [
          "Never message recipients whose public directory page states they do not wish to receive commercial messages.",
        ],
        footerRequirement: "Sender identity, physical postal address, and clear unsubscribe instruction.",
      };

    case "NG":
      return {
        region: "NG",
        frameworkName: "Nigeria Data Protection Act (NDPA)",
        requirements: [
          "Process only lawfully sourced public business/corporate contact data for legitimate B2B communication",
          "Disclose sender identity clearly and provide an instant no-cost opt-out in every message",
          "Avoid false urgency or unverified performance promises",
        ],
        b2bPermittedRules: [
          "Lawful B2B commercial outreach with clear opt-out and data-suppression honoring.",
        ],
        cautionNotes: [
          "Prioritize official company domains and published corporate channels.",
        ],
        footerRequirement: "Sender identity, business contact info, and plain opt-out instruction.",
      };

    default:
      return {
        region: "INTL",
        frameworkName: "International B2B Anti-Spam & Data Privacy Baseline",
        requirements: [
          "Contact only publicly listed corporate/business addresses relevant to the prospect's role",
          "Keep claims grounded in verified observations and include clear opt-out instructions",
          hasAddress
            ? "Physical postal address configured in Settings"
            : "Configure your business physical address in Settings for full cross-border compliance",
        ],
        b2bPermittedRules: [
          "Honest identity, data minimization, and automatic suppression-list enforcement.",
        ],
        cautionNotes: [
          "Check stricter opt-in laws if expanding into Germany, Canada, or consumer segments.",
        ],
        footerRequirement: "Clear business identity and one-step unsubscribe notice.",
      };
  }
}
