import { geminiJSON } from "./gemini";
import { Type, type Schema } from "@google/genai";
import { isFetchableUrl } from "./outreach-utils";
import {
  KB_SECTION_TEMPLATES,
  normalizeUrlInput,
  type KnowledgeSection,
  type OnboardingAnswers,
} from "./onboarding";

export interface WebsiteScanResult {
  found: boolean;
  note: string;
  businessName: string;
  description: string;
  industry: string;
  services: string[];
  offer: string;
  location: string;
  socials: {
    linkedin: string;
    x: string;
    instagram: string;
    facebook: string;
    youtube: string;
    tiktok: string;
  };
}

function stripHtmlAndExtractLinks(html: string): {
  text: string;
  links: string[];
} {
  const hrefMatches = Array.from(html.matchAll(/href=["'](https?:\/\/[^"'\s>]+)["']/gi)).map((m) => m[1]);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  return {
    text: text.slice(0, 10_000),
    links: Array.from(new Set(hrefMatches)).slice(0, 60),
  };
}

export async function scanWebsiteForOnboardingServer(rawUrl: string, model?: string): Promise<WebsiteScanResult> {
  const url = normalizeUrlInput(rawUrl);
  const emptyResult: WebsiteScanResult = {
    found: false,
    note: "We could not reach that website or extract public details. You can continue filling in your details manually.",
    businessName: "",
    description: "",
    industry: "",
    services: [],
    offer: "",
    location: "",
    socials: { linkedin: "", x: "", instagram: "", facebook: "", youtube: "", tiktok: "" },
  };

  if (!url || !isFetchableUrl(url)) {
    return {
      ...emptyResult,
      note: "Please enter a valid public https:// or http:// website address.",
    };
  }

  let pageText = "";
  let extractedLinks: string[] = [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Knowrevo-Onboarding/1.0" },
      });
      if (!res.ok) {
        return {
          ...emptyResult,
          note: `That site returned HTTP ${res.status}. No problem — fill in the fields below manually.`,
        };
      }
      const html = await res.text();
      const parsed = stripHtmlAndExtractLinks(html.slice(0, 250_000));
      pageText = parsed.text;
      extractedLinks = parsed.links;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return emptyResult;
  }

  if (pageText.length < 40) {
    return {
      ...emptyResult,
      note: "This website returned very little readable text (it may block bots or require JavaScript). You can enter your details below manually.",
    };
  }

  const findSocial = (pattern: RegExp) => extractedLinks.find((l) => pattern.test(l)) ?? "";

  const SCAN_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
      businessName: { type: Type.STRING },
      description: { type: Type.STRING },
      industry: { type: Type.STRING },
      services: { type: Type.ARRAY, items: { type: Type.STRING } },
      offer: { type: Type.STRING },
      location: { type: Type.STRING },
    },
    required: ["businessName", "description", "industry", "services", "offer", "location"],
  };

  const data = await geminiJSON<{
    businessName: string;
    description: string;
    industry: string;
    services: string[];
    offer: string;
    location: string;
  }>({
    system: `Extract factual business profile information strictly from the website text provided.
NEVER invent or guess anything not explicitly stated on the page. If a field is not stated, return an empty string "" or [].`,
    user: `Website URL: ${url}\n\nVisible Website Text:\n${pageText}`,
    schema: SCAN_SCHEMA,
    model,
  });

  const socials = {
    linkedin: findSocial(/linkedin\.com/i),
    x: findSocial(/(?:twitter\.com|x\.com)/i),
    instagram: findSocial(/instagram\.com/i),
    facebook: findSocial(/facebook\.com/i),
    youtube: findSocial(/youtube\.com|youtu\.be/i),
    tiktok: findSocial(/tiktok\.com/i),
  };

  const hasContent = Boolean(
    data.businessName.trim() ||
      data.description.trim() ||
      data.services.length > 0 ||
      Object.values(socials).some(Boolean),
  );

  if (!hasContent) {
    return {
      ...emptyResult,
      note: "We scanned the page but didn't find enough clear business details to pre-fill. Feel free to type them manually.",
    };
  }

  return {
    found: true,
    note: "Found public details from your website! Review and edit anything below before applying.",
    businessName: data.businessName.trim(),
    description: data.description.trim(),
    industry: data.industry.trim(),
    services: data.services.map((s) => s.trim()).filter(Boolean).slice(0, 8),
    offer: data.offer.trim(),
    location: data.location.trim(),
    socials,
  };
}

export async function improveAnswerServer(input: {
  questionTitle: string;
  answer: string;
  businessContext?: string;
  model?: string;
}): Promise<{ improved: string }> {
  const IMPROVE_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
      improved: { type: Type.STRING },
    },
    required: ["improved"],
  };

  return geminiJSON<{ improved: string }>({
    system: `You are a sharp B2B messaging editor.
Polish the user's draft answer to make it clearer, more specific, and better structured for an AI Knowledge Base.
CRITICAL RULE: Use ONLY facts, services, numbers, and claims the user already provided. NEVER invent new metrics, pricing, clients, or guarantees.`,
    user: `Question: ${input.questionTitle}
Business context: ${input.businessContext || "Not specified"}
User's current answer:
${input.answer}`,
    schema: IMPROVE_SCHEMA,
    model: input.model,
  });
}

export async function generateKnowledgeBaseServer(input: {
  answers: OnboardingAnswers;
  extraContext?: string;
  model?: string;
}): Promise<{ sections: KnowledgeSection[]; missingGaps: string[] }> {
  const KB_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
      sections: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            key: { type: Type.STRING },
            title: { type: Type.STRING },
            content: { type: Type.STRING },
            missingGaps: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["key", "title", "content", "missingGaps"],
        },
      },
      overallMissingGaps: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
    },
    required: ["sections", "overallMissingGaps"],
  };

  const today = new Date().toISOString().slice(0, 10);

  const system = `You compile a structured, clear, authoritative B2B Company Knowledge Base from onboarding answers.
This Knowledge Base serves as the single source of truth for Growth Advisor, Analytics, Prospect Research, and Outreach Campaign writing.

STRICT RULES:
1. Use ONLY what the user provided or confirmed in their onboarding answers. NEVER invent facts, client names, stats, guarantees, revenue figures, or claims.
2. Output ALL 10 canonical sections using these exact keys and titles:
${KB_SECTION_TEMPLATES.map((t) => `- key: "${t.key}", title: "${t.title}"`).join("\n")}
3. Where information for a section or sub-detail was skipped or left blank, write "Not provided" explicitly and list the missing detail in that section's missingGaps array AND in overallMissingGaps.
4. Format each section's content cleanly in readable Markdown bullets or concise paragraphs.`;

  const data = await geminiJSON<{
    sections: { key: string; title: string; content: string; missingGaps: string[] }[];
    overallMissingGaps: string[];
  }>({
    system,
    user: `Today: ${today}\nOnboarding Answers JSON:\n${JSON.stringify(input.answers, null, 2)}${
      input.extraContext ? `\n\nSupporting Website / Document Context (use strictly if consistent with user's answers):\n${input.extraContext.slice(0, 5000)}` : ""
    }`,
    schema: KB_SCHEMA,
    model: input.model,
  });

  const nowIso = new Date().toISOString();
  const byKey = new Map(data.sections.map((s) => [s.key, s]));

  const sections: KnowledgeSection[] = KB_SECTION_TEMPLATES.map((tpl, idx) => {
    const generated = byKey.get(tpl.key);
    return {
      id: `sec_${tpl.key}`,
      key: tpl.key,
      title: tpl.title,
      content: generated?.content?.trim() || "Not provided.",
      provenance: "ai_generated",
      updatedAt: nowIso,
      missingGaps: Array.isArray(generated?.missingGaps)
        ? generated!.missingGaps.map((g) => g.trim()).filter(Boolean)
        : idx === 0
          ? []
          : ["Section details not provided"],
    };
  });

  return {
    sections,
    missingGaps: Array.from(new Set(data.overallMissingGaps.map((g) => g.trim()).filter(Boolean))),
  };
}

export async function regenerateSectionServer(input: {
  sectionTitle: string;
  currentContent: string;
  answers?: OnboardingAnswers | null;
  knowledgeDigest?: string;
  userInstruction?: string;
  model?: string;
}): Promise<{ suggestedContent: string }> {
  const REGEN_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
      suggestedContent: { type: Type.STRING },
    },
    required: ["suggestedContent"],
  };

  return geminiJSON<{ suggestedContent: string }>({
    system: `You rewrite and polish a single Knowledge Base section.
Use ONLY truthful facts already present in the current section text, onboarding answers, or workspace knowledge.
NEVER invent statistics, metrics, guarantees, or claims. Return clear, well-structured Markdown.`,
    user: `Section Title: ${input.sectionTitle}
Current Content:
${input.currentContent}

${input.userInstruction ? `User's specific request for this rewrite: ${input.userInstruction}\n` : ""}
Additional Workspace Context:
${input.answers ? JSON.stringify(input.answers).slice(0, 4000) : input.knowledgeDigest?.slice(0, 4000) || "None"}`,
    schema: REGEN_SCHEMA,
    model: input.model,
  });
}
