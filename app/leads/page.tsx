"use client";

import { BrandLoader } from "@/components/BrandLoader";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clearPageState, usePersistedPageState } from "@/lib/usePersistedPageState";
import { Bot, Eye, Globe, Link2, Phone, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Field, Modal, Pager } from "@/components/ui";
import { confirmDialog, useToast } from "@/components/Feedback";
import { errorMessage } from "@/lib/client";
import { isLeadMissingVerifiedContact } from "@/lib/search/contactGate";
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

const PAGE_SIZE = 20;

export default function LeadsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [renderNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus, resetStatus] = usePersistedPageState<string>("leads:status", "all");
  const [campaignFilter, setCampaignFilter, resetCampaign] = usePersistedPageState<string>("leads:campaign", "all");
  const [campaignFilters, setCampaignFilters] = useState<string[]>([]);
  const [qualFilter, setQualFilter] = useState<"all" | "qualified" | "not_qualified" | "needs_review">("all");
  const [locationFilter, setLocationFilter] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const [companySizeFilter, setCompanySizeFilter] = useState("all");
  const [hasEmailFilter, setHasEmailFilter] = useState(false);
  const [hasPhoneFilter, setHasPhoneFilter] = useState(false);
  const [hasSocialFilter, setHasSocialFilter] = useState(false);
  const [needsVerificationFilter, setNeedsVerificationFilter] = usePersistedPageState<boolean>(
    "leads:needs_verification",
    false,
  );
  const [dateAddedFilter, setDateAddedFilter] = useState<"all" | "today" | "7d" | "30d">("all");
  const [scoreFilter, setScoreFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [sortOption, setSortOption] = useState<"newest" | "oldest" | "score_desc" | "score_asc" | "az" | "za">("newest");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [bulkCampaign, setBulkCampaign] = useState("");
  const [search, setSearch, resetSearch] = usePersistedPageState<string>("leads:search", "");
  const [query, setQuery] = usePersistedPageState<string>("leads:query", "");
  const [page, setPage, resetPage] = usePersistedPageState<number>("leads:page", 1);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [selectedLeadId, setSelectedLeadId] = usePersistedPageState<string | null>("leads:open", null);
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

  /**
   * The only way to close the drawer. Clearing React state, the persisted id
   * and any URL/storage trace in the same tick is what stops the modal from
   * re-opening itself after Close, Escape or a backdrop click.
   */
  const closeLead = useCallback(() => {
    setSelected(null);
    setSelectedLeadId(null);
    clearPageState("leads:open");
  }, [setSelectedLeadId]);

  // Restore the lead drawer across navigation once the list has loaded.
  useEffect(() => {
    if (loading || !selectedLeadId || selected?.id === selectedLeadId) return;
    const lead = allLeads.find((l) => l.id === selectedLeadId);
    if (!lead) {
      // The stored lead no longer exists (deleted in another tab): drop the id
      // instead of keeping a restore loop alive.
      const timer = window.setTimeout(() => {
        setSelectedLeadId(null);
        clearPageState("leads:open");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setSelected(lead), 0);
    return () => window.clearTimeout(timer);
  }, [loading, selectedLeadId, allLeads, selected, setSelectedLeadId]);

  useEffect(() => {
    if (loading) return;
    if (selected?.id && selected.id !== selectedLeadId) setSelectedLeadId(selected.id);
    else if (!selected && selectedLeadId) setSelectedLeadId(null);
  }, [loading, selected, selectedLeadId, setSelectedLeadId]);

  const unverifiedLeads = useMemo(
    () => allLeads.filter((l) => isLeadMissingVerifiedContact(l).needsVerification),
    [allLeads],
  );

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
    const now = renderNow;
    const startOfToday = new Date(renderNow);
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
      if (needsVerificationFilter && !isLeadMissingVerifiedContact(l).needsVerification) {
        return false;
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
    renderNow,
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
    needsVerificationFilter,
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
    setNeedsVerificationFilter(false);
    setDateAddedFilter("all");
    setScoreFilter("all");
    setSearch("");
    setQuery("");
    setSortOption("newest");
    setPage(1);
    setSelected(null);
    setSelectedLeadId(null);
    resetStatus();
    resetCampaign();
    resetSearch();
    resetPage();
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
    needsVerificationFilter ||
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
      message: "Its emails, follow-ups, replies and activity are deleted with it. This cannot be undone.",
      confirmLabel: "Delete prospect",
      tone: "bad",
    });
    if (!proceed) return;
    setBusy(lead.id);
    setNotice(null);
    try {
      await deleteLeadCascade(user.uid, lead.id);
      // Remove it locally first so the row disappears immediately, then clear
      // every persisted trace so the drawer cannot re-open on a dead id.
      setAllLeads((prev) => prev.filter((l) => l.id !== lead.id));
      setChecked((prev) => prev.filter((id) => id !== lead.id));
      closeLead();
      toast.success("Prospect deleted", `${lead.business ?? lead.email ?? "The prospect"} and its history were removed.`);
      await load();
    } catch (err) {
      const message = errorMessage(err);
      setNotice(message);
      toast.error("Could not delete prospect", message);
    } finally {
      setBusy(null);
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
                onChange={(e) => setSortOption(e.target.value as typeof sortOption)}
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

              {unverifiedLeads.length > 0 && (
                <>
                  <button
                    type="button"
                    className={`btn btn-sm ${needsVerificationFilter ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => {
                      setNeedsVerificationFilter((prev) => !prev);
                      setPage(1);
                    }}
                    title="Filter legacy or placeholder leads missing verified contacts"
                  >
                    Needs Contact Verification ({unverifiedLeads.length})
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy !== null}
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: `Clean ${unverifiedLeads.length} unverified / placeholder lead${unverifiedLeads.length === 1 ? "" : "s"}?`,
                        message:
                          "Removes leads with missing or synthetic placeholder contact details so they never clutter your pipeline. Validated prospects are untouched.",
                        confirmLabel: "Delete unverified leads",
                        tone: "bad",
                      });
                      if (!ok) return;
                      setBusy("clean_unverified");
                      setNotice(null);
                      try {
                        let removed = 0;
                        for (const item of unverifiedLeads) {
                          await deleteLeadCascade(user.uid, item.id);
                          removed += 1;
                        }
                        setNeedsVerificationFilter(false);
                        setChecked([]);
                        await load();
                        setNotice(`Cleaned ${removed} unverified / placeholder lead${removed === 1 ? "" : "s"}.`);
                      } catch (err) {
                        setNotice(errorMessage(err));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === "clean_unverified" ? "Cleaning…" : "Clean unverified junk"}
                  </button>
                </>
              )}
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
                      setDateAddedFilter(e.target.value as typeof dateAddedFilter);
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
                      setScoreFilter(e.target.value as typeof scoreFilter);
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
            <>
            <div className="mobile-only stack" style={{ gap: 10, padding: "0 12px 14px" }}>
              {paged.map((lead) => {
                const socials = lead.research?.socials ?? [];
                return (
                  <article
                    key={lead.id}
                    className="card"
                    style={{ padding: 12, borderRadius: 12, display: "grid", gap: 8, minWidth: 0 }}
                  >
                    <div className="row" style={{ justifyContent: "space-between", gap: 8, minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => setSelected(lead)}
                        className="strong"
                        style={{
                          border: 0,
                          background: "none",
                          padding: 0,
                          textAlign: "left",
                          minWidth: 0,
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 15,
                        }}
                      >
                        {lead.business ?? lead.email ?? "Untitled lead"}
                      </button>
                      <span className={`score ${scoreClass(lead.score)}`} style={{ flexShrink: 0 }}>
                        {lead.score ?? "—"}
                      </span>
                    </div>
                    <div
                      className="tiny muted"
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                    >
                      {lead.email ?? lead.contact_name ?? "No verified email yet"}
                    </div>
                    <div className="row" style={{ justifyContent: "space-between", gap: 8, minWidth: 0 }}>
                      <div className="tiny muted row" style={{ gap: 8, minWidth: 0, flexWrap: "nowrap" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {lead.location ?? lead.industry ?? "—"}
                        </span>
                        {lead.phone && <Phone size={13} aria-label="Phone available" style={{ flexShrink: 0 }} />}
                        {socials.some((s) => /linkedin/i.test(s.platform)) && (
                          <Link2 size={13} aria-label="LinkedIn available" style={{ flexShrink: 0 }} />
                        )}
                        {lead.website && <Globe size={13} aria-label="Website available" style={{ flexShrink: 0 }} />}
                      </div>
                      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`View ${lead.business ?? lead.email ?? "prospect"}`}
                          onClick={() => setSelected(lead)}
                          style={{ width: 44, height: 44, padding: 0, justifyContent: "center" }}
                        >
                          <Eye size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          aria-label={`Delete ${lead.business ?? lead.email ?? "prospect"}`}
                          disabled={busy === lead.id}
                          onClick={() => void remove(lead)}
                          style={{ width: 44, height: 44, padding: 0, justifyContent: "center" }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="table-wrap desktop-only">
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
                    <th style={{ width: "26%" }}>Lead / Company</th>
                    <th style={{ width: "32%" }}>Contact</th>
                    <th style={{ width: "14%" }}>Location</th>
                    <th className="num" style={{ width: "8%" }}>Score</th>
                    <th style={{ width: "12%" }}>Status</th>
                    <th style={{ width: "8%" }}>Actions</th>
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
                      <td style={{ minWidth: 0 }}>
                        <div className="strong truncate">{lead.business ?? "—"}</div>
                        <div className="tiny muted truncate" style={{ marginTop: 2 }}>
                          {[lead.industry, lead.campaign_id ? campaignNames[lead.campaign_id] : "Unassigned"]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </td>
                      <td style={{ minWidth: 0 }}>
                        {isLeadMissingVerifiedContact(lead).needsVerification ? (
                          <Badge tone="warn">Needs Contact Verification</Badge>
                        ) : (
                          <>
                            <div className="truncate" style={{ fontSize: 12.8 }}>
                              {lead.email ?? lead.contact_name ?? "—"}
                            </div>
                            <div className="row" style={{ gap: 6, marginTop: 3, alignItems: "center" }}>
                              <span className="tiny muted truncate" style={{ minWidth: 0 }}>
                                {[lead.contact_name ? `Attn: ${lead.contact_name}` : "", lead.role]
                                  .filter(Boolean)
                                  .join(" · ") || "No named contact"}
                              </span>
                              <span className="row" style={{ gap: 4, flexShrink: 0, color: "var(--ink-2)" }}>
                                {lead.phone && <Phone size={12} aria-label="Phone available" />}
                                {(lead.research?.socials ?? []).some((s) => /linkedin/i.test(s.platform)) && (
                                  <Link2 size={12} aria-label="LinkedIn available" />
                                )}
                                {lead.website && <Globe size={12} aria-label="Website available" />}
                              </span>
                            </div>
                          </>
                        )}
                      </td>
                      <td className="tiny" style={{ minWidth: 0 }}>
                        <div className="truncate">{lead.location ?? "—"}</div>
                      </td>
                      <td className="num">
                        <span className={`score ${scoreClass(lead.score)}`}>{lead.score ?? "—"}</span>
                      </td>
                      <td>
                        <Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            aria-label={`View ${lead.business ?? lead.email ?? "prospect"}`}
                            onClick={() => setSelected(lead)}
                            style={{ padding: "4px 6px" }}
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            aria-label={`Delete ${lead.business ?? lead.email ?? "prospect"}`}
                            disabled={busy === lead.id}
                            onClick={() => void remove(lead)}
                            style={{ padding: "4px 6px" }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
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
        onClose={closeLead}
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
        <dd className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span>{lead.email ?? "—"}</span>
          {lead.research?.email_type && (
            <Badge tone={lead.research.email_type === "direct" ? "ok" : "info"}>
              {lead.research.email_type === "direct" ? "Direct inbox" : "Role inbox"}
            </Badge>
          )}
          {lead.research?.mx_verified && <Badge tone="ok">MX verified</Badge>}
          {isLeadMissingVerifiedContact(lead).needsVerification && (
            <Badge tone="warn">Needs Contact Verification</Badge>
          )}
        </dd>
        <dt>Phone</dt>
        <dd>{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : "—"}</dd>
        <dt>Contact</dt>
        <dd>
          {lead.contact_name ?? "—"} {lead.role ? `· ${lead.role}` : ""}
        </dd>
        {(lead.research?.socials?.length ?? 0) > 0 && (
          <>
            <dt>Socials</dt>
            <dd className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {lead.research!.socials!.map((soc, idx) => (
                <a key={idx} href={soc.url} target="_blank" rel="noreferrer" className="tiny">
                  {soc.platform}
                </a>
              ))}
            </dd>
          </>
        )}
        {(lead.research?.contact_source_urls?.length ?? 0) > 0 && (
          <>
            <dt>Contact proof</dt>
            <dd className="stack" style={{ gap: 2 }}>
              {lead.research!.contact_source_urls!.slice(0, 4).map((src, idx) => (
                <a key={idx} href={src.sourceUrl} target="_blank" rel="noreferrer" className="tiny">
                  [{src.channel}] {src.sourceUrl}
                </a>
              ))}
            </dd>
          </>
        )}
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
                {(research.audit_evidence?.length || research.mobile_screenshot_url || research.verified_site_issues?.length) && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                      background: "var(--surface-2)",
                    }}
                  >
                    <div className="label" style={{ marginBottom: 6 }}>
                      Verified Audit Proof
                    </div>
                    <div className="row" style={{ gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                      {research.mobile_screenshot_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={research.mobile_screenshot_url}
                          alt={`Mobile view of ${lead.business || "website"}`}
                          style={{
                            width: 104,
                            height: "auto",
                            maxHeight: 190,
                            objectFit: "cover",
                            borderRadius: 6,
                            border: "1px solid var(--line-soft)",
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 180 }}>
                        {research.audit_evidence && research.audit_evidence.length > 0 ? (
                          <ul style={{ fontSize: 12.2, paddingLeft: 16, margin: 0 }}>
                            {research.audit_evidence.map((ev, idx) => (
                              <li key={idx} style={{ marginBottom: 5 }}>
                                <Badge tone="info">{ev.evidence_type}</Badge>{" "}
                                <span className="strong">{ev.issue}</span>
                                <div className="tiny muted">Proof: {ev.proof}</div>
                              </li>
                            ))}
                          </ul>
                        ) : (research.verified_site_issues?.length ?? 0) > 0 ? (
                          <ul style={{ fontSize: 12.2, paddingLeft: 16, margin: 0 }}>
                            {research.verified_site_issues!.slice(0, 3).map((issue, idx) => (
                              <li key={idx}>{issue}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="tiny muted" style={{ margin: 0 }}>
                            Site looks solid / low friction — no urgent mobile issues found.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
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
