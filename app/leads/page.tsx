"use client";

import { BrandLoader } from "@/components/BrandLoader";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckSquare, Filter, Plus, SlidersHorizontal, Square, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Field, Modal, Pager } from "@/components/ui";
import { confirmDialog } from "@/components/Feedback";
import { errorMessage } from "@/lib/client";
import { NarratorControl } from "@/components/NarratorControl";
import { AskAiResearchModal } from "@/components/AskAiResearchModal";
import {
  createLead,
  deleteLeadCascade,
  listCampaigns,
  listLeads,
  moveLeadsToCampaign,
  updateLeadFields,
} from "@/lib/store";
import { fmtDate, label, priorityTone, scoreClass, statusTone } from "@/lib/format";
import type { Campaign, Lead, LeadStatus } from "@/lib/types";

const STATUS_OPTIONS = [
  ["all", "All leads"],
  ["new", "Unprocessed"],
  ["queued_research", "Awaiting research"],
  ["researched", "Researched"],
  ["qualified", "Qualified"],
  ["email_generated", "Email drafted"],
  ["approved", "Approved"],
  ["sent", "Sent"],
  ["replied,converted", "Replied"],
  ["followup_pending", "Follow-up pending"],
  ["disqualified,needs_research", "Disqualified / needs research"],
  ["suppressed,unsubscribed,bounced", "Suppressed / bounced"],
] as const;

const PAGE_SIZE = 20;

export default function LeadsPage() {
  const { user } = useAuth();
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState("all");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [campaignFilters, setCampaignFilters] = useState<string[]>([]);
  const [qualFilter, setQualFilter] = useState<"all" | "qualified" | "not_qualified" | "needs_review">("all");
  const [locationFilter, setLocationFilter] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const [companySizeFilter, setCompanySizeFilter] = useState("all");
  const [hasEmailFilter, setHasEmailFilter] = useState(false);
  const [hasPhoneFilter, setHasPhoneFilter] = useState(false);
  const [hasSocialFilter, setHasSocialFilter] = useState(false);
  const [dateAddedFilter, setDateAddedFilter] = useState<"all" | "today" | "7d" | "30d">("all");
  const [scoreFilter, setScoreFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [sortOption, setSortOption] = useState<"newest" | "oldest" | "score_desc" | "score_asc" | "az" | "za">("newest");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [bulkCampaign, setBulkCampaign] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newLead, setNewLead] = useState({
    business: "",
    contact_name: "",
    role: "",
    email: "",
    website: "",
    location: "",
    industry: "",
    notes: "",
    campaignId: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [leadsRes, campRes] = await Promise.all([listLeads(user.uid), listCampaigns(user.uid)]);
      setAllLeads(leadsRes);
      setCampaigns(campRes);
      setSelected((prev) => (prev ? leadsRes.find((l) => l.id === prev.id) ?? null : null));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    Promise.all([listLeads(user.uid), listCampaigns(user.uid)]).then(
      ([leadsRes, campRes]) => {
        if (!active) return;
        setAllLeads(leadsRes);
        setCampaigns(campRes);
        setSelected((prev) => (prev ? leadsRes.find((l) => l.id === prev.id) ?? null : null));
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of allLeads) {
      map[l.status] = (map[l.status] ?? 0) + 1;
    }
    return map;
  }, [allLeads]);

  const campaignNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of campaigns) map[c.id] = c.name;
    return map;
  }, [campaigns]);

  const campaignCounts = useMemo(() => {
    const map: Record<string, number> = { unassigned: 0 };
    for (const l of allLeads) {
      const key = l.campaign_id ?? "unassigned";
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [allLeads]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const loc = locationFilter.trim().toLowerCase();
    const ind = industryFilter.trim().toLowerCase();
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const result = allLeads.filter((l) => {
      // 1. Campaign filter (multi or single)
      if (campaignFilters.length > 0) {
        const matchesUnassigned = campaignFilters.includes("unassigned") && !l.campaign_id;
        const matchesCampaign = Boolean(l.campaign_id && campaignFilters.includes(l.campaign_id));
        if (!matchesUnassigned && !matchesCampaign) return false;
      } else if (campaignFilter !== "all") {
        if (campaignFilter === "unassigned" && l.campaign_id) return false;
        if (campaignFilter !== "unassigned" && l.campaign_id !== campaignFilter) return false;
      }

      // 2. Qualification status filter
      if (qualFilter === "qualified") {
        const isQualified =
          ["qualified", "email_generated", "approved", "sent", "replied", "converted"].includes(l.status) ||
          l.score_reason?.category === "high" ||
          l.score_reason?.category === "medium";
        if (!isQualified) return false;
      } else if (qualFilter === "not_qualified") {
        const isDisqualified = l.status === "disqualified" || l.score_reason?.category === "not_qualified";
        if (!isDisqualified) return false;
      } else if (qualFilter === "needs_review") {
        const isNeedsReview =
          ["new", "queued_research", "researched", "needs_research"].includes(l.status) ||
          l.score_reason?.category === "needs_research";
        if (!isNeedsReview) return false;
      }

      // Legacy single status dropdown if status !== 'all'
      if (status !== "all") {
        const allowedStatuses = new Set(status.split(","));
        if (!allowedStatuses.has(l.status)) return false;
      }

      // 3. Location filter
      if (loc && !(l.location ?? "").toLowerCase().includes(loc)) {
        return false;
      }

      // 4. Industry filter
      if (ind && !(l.industry ?? "").toLowerCase().includes(ind)) {
        return false;
      }

      // 5. Company size filter
      if (companySizeFilter !== "all") {
        const combined = `${l.notes ?? ""} ${l.extra ?? ""}`.toLowerCase();
        if (!combined.includes(companySizeFilter.toLowerCase())) {
          return false;
        }
      }

      // 6. Contact info available
      if (hasEmailFilter && !l.email?.trim()) return false;
      if (hasPhoneFilter && !l.phone?.trim()) return false;
      if (hasSocialFilter) {
        const notesLower = (l.notes ?? "").toLowerCase();
        const hasSocialInNotes =
          notesLower.includes("social") ||
          notesLower.includes("linkedin") ||
          notesLower.includes("instagram") ||
          notesLower.includes("twitter") ||
          notesLower.includes("facebook") ||
          notesLower.includes("tiktok") ||
          notesLower.includes("youtube");
        const hasSocialInResearch = Boolean((l.research as unknown as { socials?: unknown[] })?.socials?.length);
        if (!hasSocialInNotes && !hasSocialInResearch) return false;
      }

      // 7. Date added filter
      if (dateAddedFilter === "today") {
        const addedTime = new Date(l.created_at).getTime();
        if (addedTime < startOfToday.getTime()) return false;
      } else if (dateAddedFilter === "7d") {
        const addedTime = new Date(l.created_at).getTime();
        if (addedTime < now - 7 * 86400 * 1000) return false;
      } else if (dateAddedFilter === "30d") {
        const addedTime = new Date(l.created_at).getTime();
        if (addedTime < now - 30 * 86400 * 1000) return false;
      }

      // 8. Lead score / buying-intent level
      const score = l.score ?? 0;
      if (scoreFilter === "high" && score < 80) return false;
      if (scoreFilter === "medium" && (score < 60 || score >= 80)) return false;
      if (scoreFilter === "low" && score >= 60) return false;

      // 9. Search box query
      if (!q) return true;
      const haystack = `${l.business ?? ""} ${l.contact_name ?? ""} ${l.role ?? ""} ${l.email ?? ""} ${l.phone ?? ""} ${l.industry ?? ""} ${l.location ?? ""} ${l.notes ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });

    // 10. Sorting
    result.sort((a, b) => {
      if (sortOption === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      if (sortOption === "oldest") {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      if (sortOption === "score_desc") {
        return (b.score ?? -1) - (a.score ?? -1);
      }
      if (sortOption === "score_asc") {
        return (a.score ?? 999) - (b.score ?? 999);
      }
      if (sortOption === "az") {
        return (a.business ?? "").localeCompare(b.business ?? "");
      }
      if (sortOption === "za") {
        return (b.business ?? "").localeCompare(a.business ?? "");
      }
      return 0;
    });

    return result;
  }, [
    allLeads,
    campaignFilters,
    campaignFilter,
    qualFilter,
    status,
    locationFilter,
    industryFilter,
    companySizeFilter,
    hasEmailFilter,
    hasPhoneFilter,
    hasSocialFilter,
    dateAddedFilter,
    scoreFilter,
    query,
    sortOption,
  ]);

  const clearAllFilters = () => {
    setStatus("all");
    setCampaignFilter("all");
    setCampaignFilters([]);
    setQualFilter("all");
    setLocationFilter("");
    setIndustryFilter("");
    setCompanySizeFilter("all");
    setHasEmailFilter(false);
    setHasPhoneFilter(false);
    setHasSocialFilter(false);
    setDateAddedFilter("all");
    setScoreFilter("all");
    setSearch("");
    setQuery("");
    setSortOption("newest");
    setPage(1);
  };

  const hasActiveFilters = Boolean(
    status !== "all" ||
    campaignFilter !== "all" ||
    campaignFilters.length > 0 ||
    qualFilter !== "all" ||
    locationFilter ||
    industryFilter ||
    companySizeFilter !== "all" ||
    hasEmailFilter ||
    hasPhoneFilter ||
    hasSocialFilter ||
    dateAddedFilter !== "all" ||
    scoreFilter !== "all" ||
    query,
  );

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const update = async (
    id: string,
    patch: { manual_research?: string | null; notes?: string | null; status?: LeadStatus; action?: "requeue" },
  ) => {
    setBusy(id);
    setNotice(null);
    try {
      await updateLeadFields(user.uid, id, patch);
      await load();
      setNotice("Saved.");
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (lead: Lead) => {
    const proceed = await confirmDialog({
      title: `Delete ${lead.business ?? lead.email}?`,
      message: "Its messages and replies are deleted with it. This cannot be undone.",
      confirmLabel: "Delete prospect",
      tone: "bad",
    });
    if (!proceed) return;
    try {
      await deleteLeadCascade(user.uid, lead.id);
      setSelected(null);
      await load();
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const moveTo = async (ids: string[], campaignId: string | null) => {
    if (ids.length === 0) return;
    setBusy("move");
    setNotice(null);
    try {
      const moved = await moveLeadsToCampaign(user.uid, ids, campaignId);
      setChecked([]);
      await load();
      if (moved === 0) {
        setNotice("Nothing to move: those prospects are already there.");
      } else if (campaignId) {
        setNotice(
          `Moved ${moved} prospect${moved === 1 ? "" : "s"} to ${campaignNames[campaignId] ?? "the campaign"}. Untouched ones joined its research queue; contacted ones keep their stage.`,
        );
      } else {
        setNotice(`Took ${moved} prospect${moved === 1 ? "" : "s"} out of their campaign.`);
      }
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleAddLead = async () => {
    if (!newLead.business.trim() && !newLead.email.trim()) {
      setNotice("Enter a business name or email address.");
      return;
    }
    setBusy("create");
    setNotice(null);
    try {
      const res = await createLead(user.uid, {
        ...newLead,
        campaignId: newLead.campaignId || null,
      });
      setAddOpen(false);
      setNewLead({
        business: "",
        contact_name: "",
        role: "",
        email: "",
        website: "",
        location: "",
        industry: "",
        notes: "",
        campaignId: "",
      });
      await load();
      setNotice(res.duplicate ? "That email already exists in your leads." : "Lead added.");
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Leads</h1>
          <p className="page-sub">
            Every prospect in one place with its research, score and outreach history. Add manual notes or extra
            research to improve the copy Gemini writes.
          </p>
        </div>
        <div className="row-end">
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)} type="button">
            <Plus size={14} />
            <span>Add lead</span>
          </button>
        </div>
      </div>

      <div className="stack">
        <Card tight>
          <div className="stack" style={{ padding: "14px 16px", gap: 12 }}>
            {/* Primary Filter & Search Bar */}
            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ position: "relative", flex: "1 1 240px", minWidth: 200 }}>
                <input
                  className="input"
                  style={{ width: "100%" }}
                  placeholder="Search business, contact, email, location…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setQuery(search);
                      setPage(1);
                    }
                  }}
                />
              </div>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setQuery(search);
                  setPage(1);
                }}
              >
                Search
              </button>

              {/* Qualification Filter */}
              <select
                className="select"
                style={{ width: 170 }}
                value={qualFilter}
                onChange={(e) => {
                  setQualFilter(e.target.value as "all" | "qualified" | "not_qualified" | "needs_review");
                  setPage(1);
                }}
                title="Filter by Qualification Status"
              >
                <option value="all">Qualification: All</option>
                <option value="qualified">Qualified</option>
                <option value="needs_review">Needs review</option>
                <option value="not_qualified">Not qualified</option>
              </select>

              {/* Campaign Filter */}
              <select
                className="select"
                style={{ width: 180 }}
                value={campaignFilter}
                onChange={(e) => {
                  setCampaignFilter(e.target.value);
                  setPage(1);
                }}
                title="Filter by Campaign"
              >
                <option value="all">All campaigns</option>
                <option value="unassigned">Unassigned ({campaignCounts.unassigned ?? 0})</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({campaignCounts[c.id] ?? 0})
                  </option>
                ))}
              </select>

              {/* Sort Dropdown */}
              <select
                className="select"
                style={{ width: 160 }}
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value as any)}
                title="Sort options"
              >
                <option value="newest">Sort: Newest first</option>
                <option value="oldest">Sort: Oldest first</option>
                <option value="score_desc">Sort: Highest score</option>
                <option value="score_asc">Sort: Lowest score</option>
                <option value="az">Sort: Business A-Z</option>
                <option value="za">Sort: Business Z-A</option>
              </select>

              {/* Advanced Filters Toggle */}
              <button
                type="button"
                className={`btn btn-sm ${showAdvancedFilters ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setShowAdvancedFilters((prev) => !prev)}
                style={{ gap: 6 }}
              >
                <SlidersHorizontal size={13} aria-hidden="true" />
                Filters
              </button>
            </div>

            {/* Advanced Filters Drawer */}
            {showAdvancedFilters && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 8,
                  background: "var(--surface-sunken, rgba(0,0,0,0.03))",
                  border: "1px solid var(--line)",
                }}
              >
                <div>
                  <label className="tiny strong" style={{ display: "block", marginBottom: 4 }}>Location</label>
                  <input
                    className="input"
                    style={{ width: "100%", height: 32, fontSize: 12 }}
                    placeholder="e.g. Austin, Lagos, London"
                    value={locationFilter}
                    onChange={(e) => {
                      setLocationFilter(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>

                <div>
                  <label className="tiny strong" style={{ display: "block", marginBottom: 4 }}>Industry / Niche</label>
                  <input
                    className="input"
                    style={{ width: "100%", height: 32, fontSize: 12 }}
                    placeholder="e.g. Dental, Legal, SaaS"
                    value={industryFilter}
                    onChange={(e) => {
                      setIndustryFilter(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>

                <div>
                  <label className="tiny strong" style={{ display: "block", marginBottom: 4 }}>Company Size</label>
                  <select
                    className="select"
                    style={{ width: "100%", height: 32, fontSize: 12 }}
                    value={companySizeFilter}
                    onChange={(e) => {
                      setCompanySizeFilter(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">Any company size</option>
                    <option value="1-10">1-10 employees</option>
                    <option value="11-50">11-50 employees</option>
                    <option value="51-200">51-200 employees</option>
                    <option value="200+">200+ employees</option>
                  </select>
                </div>

                <div>
                  <label className="tiny strong" style={{ display: "block", marginBottom: 4 }}>Date Added</label>
                  <select
                    className="select"
                    style={{ width: "100%", height: 32, fontSize: 12 }}
                    value={dateAddedFilter}
                    onChange={(e) => {
                      setDateAddedFilter(e.target.value as any);
                      setPage(1);
                    }}
                  >
                    <option value="all">All time</option>
                    <option value="today">Added today</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                  </select>
                </div>

                <div>
                  <label className="tiny strong" style={{ display: "block", marginBottom: 4 }}>Lead Score / Intent</label>
                  <select
                    className="select"
                    style={{ width: "100%", height: 32, fontSize: 12 }}
                    value={scoreFilter}
                    onChange={(e) => {
                      setScoreFilter(e.target.value as any);
                      setPage(1);
                    }}
                  >
                    <option value="all">All scores</option>
                    <option value="high">High intent (80+)</option>
                    <option value="medium">Medium intent (60-79)</option>
                    <option value="low">Low intent (&lt;60)</option>
                  </select>
                </div>

                <div>
                  <label className="tiny strong" style={{ display: "block", marginBottom: 4 }}>Contact Info Available</label>
                  <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11.5 }}>
                      <input
                        type="checkbox"
                        checked={hasEmailFilter}
                        onChange={(e) => {
                          setHasEmailFilter(e.target.checked);
                          setPage(1);
                        }}
                      />
                      Email
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11.5 }}>
                      <input
                        type="checkbox"
                        checked={hasPhoneFilter}
                        onChange={(e) => {
                          setHasPhoneFilter(e.target.checked);
                          setPage(1);
                        }}
                      />
                      Phone
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11.5 }}>
                      <input
                        type="checkbox"
                        checked={hasSocialFilter}
                        onChange={(e) => {
                          setHasSocialFilter(e.target.checked);
                          setPage(1);
                        }}
                      />
                      Social Handles
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* Active Filter Chips & Results Count Bar */}
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, borderTop: "1px solid var(--line-soft)", paddingTop: 8 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="tiny strong" style={{ color: "var(--ink-2)" }}>
                  Showing {filtered.length} of {allLeads.length} prospects
                </span>

                {qualFilter !== "all" && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Status: {qualFilter.replace("_", " ")}
                    <button type="button" onClick={() => setQualFilter("all")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {campaignFilter !== "all" && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Campaign: {campaignFilter === "unassigned" ? "Unassigned" : campaignNames[campaignFilter] ?? campaignFilter}
                    <button type="button" onClick={() => setCampaignFilter("all")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {locationFilter && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Location: {locationFilter}
                    <button type="button" onClick={() => setLocationFilter("")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {industryFilter && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Industry: {industryFilter}
                    <button type="button" onClick={() => setIndustryFilter("")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {companySizeFilter !== "all" && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Size: {companySizeFilter}
                    <button type="button" onClick={() => setCompanySizeFilter("all")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {hasEmailFilter && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Has Email
                    <button type="button" onClick={() => setHasEmailFilter(false)} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {hasPhoneFilter && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Has Phone
                    <button type="button" onClick={() => setHasPhoneFilter(false)} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {hasSocialFilter && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Has Socials
                    <button type="button" onClick={() => setHasSocialFilter(false)} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {dateAddedFilter !== "all" && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Added: {dateAddedFilter === "today" ? "Today" : dateAddedFilter === "7d" ? "Last 7 days" : "Last 30 days"}
                    <button type="button" onClick={() => setDateAddedFilter("all")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {scoreFilter !== "all" && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Score: {scoreFilter === "high" ? "80+" : scoreFilter === "medium" ? "60-79" : "<60"}
                    <button type="button" onClick={() => setScoreFilter("all")} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}

                {query && (
                  <span
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--surface-sunken, #f1f5f9)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    Search: &ldquo;{query}&rdquo;
                    <button type="button" onClick={() => { setQuery(""); setSearch(""); }} style={{ border: 0, background: "none", cursor: "pointer", padding: 0 }}>
                      <X size={10} />
                    </button>
                  </span>
                )}
              </div>

              {hasActiveFilters && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={clearAllFilters}
                  style={{ fontSize: 11.5, color: "var(--danger, #dc2626)" }}
                >
                  Clear all filters
                </button>
              )}
            </div>
          </div>

          {notice && (
            <div style={{ padding: "0 16px 12px" }}>
              <Banner tone="info">{notice}</Banner>
            </div>
          )}
          {error && (
            <div style={{ padding: "0 16px 12px" }}>
              <Banner tone="bad">{error}</Banner>
            </div>
          )}

          {loading && allLeads.length === 0 ? (
            <div style={{ padding: 18 }}>
              <BrandLoader />
            </div>
          ) : paged.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="No leads match this view">
                Import a Google Sheet or click &ldquo;Add lead&rdquo; to get started.
              </Empty>
            </div>
          ) : (
            <div className="table-wrap">
              {checked.length > 0 && (
                <div className="row" style={{ padding: "0 16px 12px", gap: 8 }}>
                  <span className="tiny">
                    {checked.length} selected
                  </span>
                  <select
                    className="select"
                    style={{ width: 220 }}
                    value={bulkCampaign}
                    onChange={(e) => setBulkCampaign(e.target.value)}
                  >
                    <option value="">Move to campaign…</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-sm btn-primary"
                    type="button"
                    disabled={!bulkCampaign || busy !== null}
                    onClick={() => void moveTo(checked, bulkCampaign)}
                  >
                    {busy === "move" ? "Moving…" : "Move"}
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void moveTo(checked, null)}
                  >
                    Take out of campaign
                  </button>
                  <button className="btn btn-sm btn-ghost" type="button" onClick={() => setChecked([])}>
                    Clear
                  </button>
                </div>
              )}
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Select this page"
                        checked={paged.length > 0 && paged.every((l) => checked.includes(l.id))}
                        onChange={(e) =>
                          setChecked((prev) =>
                            e.target.checked
                              ? Array.from(new Set([...prev, ...paged.map((l) => l.id)]))
                              : prev.filter((id) => !paged.some((l) => l.id === id)),
                          )
                        }
                      />
                    </th>
                    <th>Business</th>
                    <th>Contact</th>
                    <th>Industry</th>
                    <th>Campaign</th>
                    <th className="num">Score</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((lead) => (
                    <tr key={lead.id} className="clickable" onClick={() => setSelected(lead)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${lead.business ?? lead.email ?? lead.id}`}
                          checked={checked.includes(lead.id)}
                          onChange={(e) =>
                            setChecked((prev) =>
                              e.target.checked ? [...prev, lead.id] : prev.filter((id) => id !== lead.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="strong">{lead.business ?? "—"}</div>
                        <div className="tiny">
                          {lead.email ?? "no email"} {lead.location ? `· ${lead.location}` : ""}
                        </div>
                      </td>
                      <td>
                        {lead.contact_name ?? "—"}
                        <div className="tiny">{lead.role ?? ""}</div>
                      </td>
                      <td>{lead.industry ?? "—"}</td>
                      <td className="tiny nowrap">
                        {lead.campaign_id ? (
                          campaignNames[lead.campaign_id] ?? "Campaign"
                        ) : (
                          <span className="tiny">Unassigned</span>
                        )}
                      </td>
                      <td className="num">
                        <span className={`score ${scoreClass(lead.score)}`}>{lead.score ?? "—"}</span>
                      </td>
                      <td>{lead.priority ? <Badge tone={priorityTone(lead.priority)}>{label(lead.priority)}</Badge> : "—"}</td>
                      <td>
                        <Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge>
                      </td>
                      <td className="tiny nowrap">{fmtDate(lead.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: "0 16px 14px" }}>
            <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
          </div>
        </Card>
      </div>

      <LeadDetail
        key={selected?.id ?? "none"}
        lead={selected}
        campaigns={campaigns}
        busy={busy === selected?.id || busy === "move"}
        onClose={() => setSelected(null)}
        onSave={async (patch) => {
          if (selected) await update(selected.id, patch);
        }}
        onMove={async (campaignId) => {
          if (selected) await moveTo([selected.id], campaignId);
        }}
        onDelete={() => selected && void remove(selected)}
      />

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add prospect manually">
        <div className="grid grid-2">
          <Field label="Business name">
            <input
              className="input"
              value={newLead.business}
              onChange={(e) => setNewLead((p) => ({ ...p, business: e.target.value }))}
            />
          </Field>
          <Field label="Email address">
            <input
              className="input"
              type="email"
              value={newLead.email}
              onChange={(e) => setNewLead((p) => ({ ...p, email: e.target.value }))}
            />
          </Field>
          <Field label="Contact name">
            <input
              className="input"
              value={newLead.contact_name}
              onChange={(e) => setNewLead((p) => ({ ...p, contact_name: e.target.value }))}
            />
          </Field>
          <Field label="Role">
            <input
              className="input"
              value={newLead.role}
              onChange={(e) => setNewLead((p) => ({ ...p, role: e.target.value }))}
            />
          </Field>
          <Field label="Website">
            <input
              className="input"
              value={newLead.website}
              onChange={(e) => setNewLead((p) => ({ ...p, website: e.target.value }))}
              placeholder="https://example.com"
            />
          </Field>
          <Field label="Industry">
            <input
              className="input"
              value={newLead.industry}
              onChange={(e) => setNewLead((p) => ({ ...p, industry: e.target.value }))}
            />
          </Field>
          <Field label="Location">
            <input
              className="input"
              value={newLead.location}
              onChange={(e) => setNewLead((p) => ({ ...p, location: e.target.value }))}
            />
          </Field>
          <Field label="Assign to campaign (optional)">
            <select
              className="select"
              value={newLead.campaignId}
              onChange={(e) => setNewLead((p) => ({ ...p, campaignId: e.target.value }))}
            >
              <option value="">Leave unassigned</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            className="textarea"
            value={newLead.notes}
            onChange={(e) => setNewLead((p) => ({ ...p, notes: e.target.value }))}
          />
        </Field>
        <div className="row">
          <button className="btn btn-primary" disabled={busy === "create"} onClick={() => void handleAddLead()} type="button">
            {busy === "create" ? "Saving…" : "Create lead"}
          </button>
        </div>
      </Modal>
    </main>
  );
}

function LeadDetail({
  lead,
  campaigns,
  busy,
  onClose,
  onSave,
  onMove,
  onDelete,
}: {
  lead: Lead | null;
  campaigns: Campaign[];
  busy: boolean;
  onClose: () => void;
  onSave: (patch: { manual_research?: string | null; status?: LeadStatus; action?: "requeue" }) => Promise<void>;
  onMove: (campaignId: string | null) => Promise<void>;
  onDelete: () => void;
}) {
  const [manual, setManual] = useState(lead?.manual_research ?? "");
  const [askAiOpen, setAskAiOpen] = useState(false);

  if (!lead) return null;

  const research = lead.research;
  const qualification = lead.score_reason;

  const narrative = `${lead.business || "Prospect"} in ${lead.location || "unspecified location"}. Status: ${label(lead.status)}. ${research?.summary ? `Research summary: ${research.summary}.` : "No research summary stored."} ${qualification?.opportunity ? `Observed opportunity: ${qualification.opportunity}.` : ""} ${qualification?.reasons?.length ? `Qualification reasons: ${qualification.reasons.join(". ")}.` : ""} ${qualification?.disqualify_reason ? `Disqualification reason: ${qualification.disqualify_reason}.` : ""}`;

  return (
    <>
      <Modal open={Boolean(lead)} onClose={onClose} title={lead.business ?? "Prospect"} large>
        <div className="row" style={{ marginBottom: 12, alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge>
          {lead.priority && <Badge tone={priorityTone(lead.priority)}>{label(lead.priority)} priority</Badge>}
          {lead.score !== null && <Badge tone="info">Score {lead.score}</Badge>}

          <NarratorControl text={narrative} />

          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ height: 26, padding: "0 8px", fontSize: 11.5, gap: 4 }}
            onClick={() => setAskAiOpen(true)}
            title="Chat with AI about this lead's research"
          >
            <Bot size={13} aria-hidden="true" />
            Ask AI
          </button>

          <div className="row-end">
            <button className="btn btn-sm btn-danger" onClick={onDelete} type="button">
              Delete lead
            </button>
          </div>
        </div>

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Email</dt>
        <dd>{lead.email ?? "—"}</dd>
        <dt>Contact</dt>
        <dd>
          {lead.contact_name ?? "—"} {lead.role ? `· ${lead.role}` : ""}
        </dd>
        <dt>Website</dt>
        <dd>
          {lead.website ? (
            <a href={lead.website} target="_blank" rel="noreferrer">
              {lead.website}
            </a>
          ) : (
            "—"
          )}
        </dd>
        <dt>Location / industry</dt>
        <dd>
          {lead.location ?? "—"} · {lead.industry ?? "—"}
        </dd>
        <dt>Source</dt>
        <dd>
          {lead.source ?? "—"} {lead.sheet_row ? `· row ${lead.sheet_row}` : ""}
        </dd>
        <dt>Research date</dt>
        <dd>{lead.research_at ? fmtDate(lead.research_at) : "Not researched"}</dd>
      </dl>

      <div className="grid grid-2">
        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Research
            </div>
            {research ? (
              <>
                <p style={{ fontSize: 13.2 }}>{research.summary}</p>
                <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                  <Badge tone={research.insufficient_data ? "warn" : "ok"}>
                    Confidence {research.confidence}/100
                  </Badge>
                  <Badge>Website: {research.website_status.replace(/_/g, " ")}</Badge>
                </div>
                {research.findings.length > 0 && (
                  <ul style={{ fontSize: 12.8, paddingLeft: 16 }}>
                    {research.findings.map((finding, index) => (
                      <li key={index} style={{ marginBottom: 4 }}>
                        <span className="strong">{finding.area}</span> ({finding.severity}): {finding.observation}
                        {finding.evidence && <span className="tiny"> — evidence: {finding.evidence}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {research.inferences.length > 0 && (
                  <p className="tiny">Inferences (unverified): {research.inferences.join("; ")}</p>
                )}
                <p className="tiny" style={{ marginTop: 6 }}>
                  <strong>Angle:</strong> {research.recommended_angle}
                </p>
              </>
            ) : (
              <p className="tiny">No research yet. Run research from the Prospect research page.</p>
            )}
          </div>

          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Qualification
            </div>
            {qualification ? (
              <>
                <p style={{ fontSize: 13 }}>{qualification.opportunity}</p>
                <ul className="tiny" style={{ paddingLeft: 16 }}>
                  {(qualification.reasons ?? []).map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
                {qualification.disqualify_reason && (
                  <p className="tiny">Why not qualified: {qualification.disqualify_reason}</p>
                )}
                <p className="tiny">
                  Recommended service: {qualification.recommended_service ?? "—"} · Value:{" "}
                  {qualification.value_tier ?? "—"}
                </p>
              </>
            ) : (
              <p className="tiny">Not qualified yet.</p>
            )}
          </div>
        </div>

        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Your own research and instructions
            </div>
            <textarea
              className="textarea"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Anything you know about this business: observations, conversations, site issues, extra instructions for the email."
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                disabled={busy}
                type="button"
                onClick={() => void onSave({ manual_research: manual })}
              >
                {busy ? "Saving…" : "Save notes"}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy}
                type="button"
                onClick={() => void onSave({ manual_research: manual, action: "requeue" })}
              >
                Save and re-research
              </button>
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              Saving notes and choosing re-research discards the stored research and puts this prospect back in the
              research queue, so Gemini can incorporate your notes.
            </p>
          </div>

          <Field label="Status">
            <select
              className="select"
              value={lead.status}
              onChange={(e) => void onSave({ status: e.target.value as LeadStatus })}
            >
              {[
                "new",
                "queued_research",
                "qualified",
                "disqualified",
                "needs_research",
                "converted",
                "email_generated",
                "approved",
              ].map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Campaign">
            <select
              className="select"
              value={lead.campaign_id ?? ""}
              disabled={busy}
              onChange={(e) => void onMove(e.target.value || null)}
            >
              <option value="">No campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.id === lead.campaign_id ? " (current)" : ""}
                </option>
              ))}
            </select>
            <p className="hint" style={{ marginTop: 6 }}>
              Moving a prospect keeps its research, score and email history. An untouched prospect joins the new
              campaign&apos;s research queue; one already contacted keeps its stage so it is never emailed twice.
            </p>
          </Field>

          {lead.extra && (
            <div>
              <div className="label" style={{ marginBottom: 4 }}>
                Extra sheet data
              </div>
              <p className="tiny">{lead.extra}</p>
            </div>
          )}
        </div>
      </div>
    </Modal>

    {askAiOpen && (
      <AskAiResearchModal
        open={askAiOpen}
        onClose={() => setAskAiOpen(false)}
        prospectName={lead.business || lead.email || "Prospect"}
        prospectData={lead as unknown as Record<string, unknown>}
      />
    )}
  </>
  );
}
