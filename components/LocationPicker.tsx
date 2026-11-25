"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, MapPin, Search, X } from "lucide-react";
import {
  GEO_CONTINENTS,
  citiesIn,
  countriesIn,
  findCountry,
  geoLabel,
  isGeoEmpty,
  rememberLocation,
  statesIn,
  useRecentLocations,
  type GeoSelection,
} from "@/lib/geo";

interface SearchSelectProps {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  multiple?: boolean;
  selected?: string[];
  onToggle?: (value: string) => void;
  hint?: string;
}

/**
 * One keyboard-accessible combobox: a filterable dropdown that never renders
 * more than a screenful of options. Multi-select keeps the popover open and
 * toggles values with Enter or Space.
 */
function SearchSelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  multiple,
  selected = [],
  onToggle,
  hint,
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  // Closing resets the filter here rather than in an effect, so no state is set
  // during a render pass.
  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 300);
    return options.filter((option) => option.toLowerCase().includes(q)).slice(0, 300);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  const commit = (option: string) => {
    if (multiple) {
      onToggle?.(option);
      return;
    }
    onChange(option);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[active];
      if (option) commit(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const display = multiple ? (selected.length ? `${selected.length} selected` : "") : value;

  return (
    <div className="geo-field" ref={rootRef}>
      <label className="geo-label">
        {label}
        {hint ? <span className="geo-hint">{hint}</span> : null}
      </label>
      <button
        type="button"
        className="geo-trigger"
        data-empty={display ? "false" : "true"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="geo-trigger-text">{display || placeholder || `Select ${label.toLowerCase()}`}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div className="geo-pop" role="presentation">
          <div className="geo-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={`Search ${label.toLowerCase()}`}
              aria-label={`Search ${label}`}
              aria-controls={listId}
              aria-autocomplete="list"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <ul className="geo-list" id={listId} role="listbox" aria-multiselectable={multiple || undefined}>
            {filtered.length === 0 ? (
              <li className="geo-empty">No match. Pick the level above first.</li>
            ) : (
              filtered.map((option, index) => {
                const isSelected = multiple ? selected.includes(option) : option === value;
                return (
                  <li key={option} role="option" aria-selected={isSelected}>
                    <button
                      type="button"
                      className="geo-option"
                      data-active={index === active ? "true" : "false"}
                      data-selected={isSelected ? "true" : "false"}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => commit(option)}
                    >
                      <span>{option}</span>
                      {isSelected ? <Check size={13} aria-hidden="true" /> : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {multiple ? (
            <div className="geo-pop-foot">
              <span className="tiny">{selected.length} selected</span>
              <button type="button" className="btn btn-sm" onClick={close}>
                Done
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LocationPicker({
  value,
  onChange,
  title = "Where",
  hint,
}: {
  value: GeoSelection;
  onChange: (value: GeoSelection) => void;
  title?: string;
  hint?: string;
}) {
  const recent = useRecentLocations();

  const countryOptions = useMemo(() => countriesIn(value.continent).map((country) => country.name), [value.continent]);
  const stateOptions = useMemo(() => statesIn(value.country), [value.country]);
  const cityOptions = useMemo(() => citiesIn(value.country, value.state), [value.country, value.state]);

  const patch = (next: Partial<GeoSelection>) => {
    const merged: GeoSelection = { ...value, ...next };
    if (next.continent !== undefined && next.continent !== value.continent) {
      merged.country = "";
      merged.state = "";
      merged.cities = [];
    } else if (next.country !== undefined && next.country !== value.country) {
      merged.state = "";
      merged.cities = [];
    } else if (next.state !== undefined && next.state !== value.state) {
      merged.cities = [];
    }
    onChange(merged);
  };

  const remember = () => {
    rememberLocation(value);
  };

  const country = findCountry(value.country);
  const label = geoLabel(value);

  return (
    <div className="geo-picker">
      <div className="geo-picker-head">
        <span className="geo-picker-title">
          <MapPin size={14} aria-hidden="true" />
          {title}
        </span>
        {label ? <span className="geo-picker-summary">{label}</span> : null}
      </div>
      {hint ? <p className="geo-picker-hint">{hint}</p> : null}

      <div className="geo-grid">
        <SearchSelect
          label="Continent"
          value={value.continent}
          options={GEO_CONTINENTS}
          onChange={(next) => patch({ continent: next })}
        />
        <SearchSelect
          label="Country"
          value={value.country}
          options={countryOptions}
          onChange={(next) => {
            const found = findCountry(next);
            const continent = found?.continent ?? value.continent;
            patch({ country: next, continent });
            rememberLocation({ ...value, country: next, continent });
          }}
          disabled={countryOptions.length === 0}
          placeholder={value.continent ? "Select country" : "Any country"}
        />
        <SearchSelect
          label="State / region"
          value={value.state}
          options={stateOptions}
          onChange={(next) => patch({ state: next })}
          disabled={!country || stateOptions.length === 0}
          placeholder={country ? (stateOptions.length ? "Select region" : "No regions listed") : "Select country first"}
        />
        <SearchSelect
          label="City"
          value={value.cities[0] ?? ""}
          options={cityOptions}
          onChange={() => undefined}
          multiple
          selected={value.cities}
          onToggle={(next) =>
            patch({
              cities: value.cities.includes(next)
                ? value.cities.filter((city) => city !== next)
                : [...value.cities, next].slice(0, 6),
            })
          }
          disabled={cityOptions.length === 0}
          placeholder={value.state ? (cityOptions.length ? "Select cities" : "No cities listed") : "Select region first"}
        />
      </div>

      {value.cities.length > 0 ? (
        <div className="geo-chips">
          {value.cities.map((city) => (
            <span key={city} className="geo-chip">
              {city}
              <button
                type="button"
                onClick={() => patch({ cities: value.cities.filter((item) => item !== city) })}
                aria-label={`Remove ${city}`}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="geo-area">
        <label className="geo-label" htmlFor="geo-area-input">
          Specific place / area
          <span className="geo-hint">Optional — a neighbourhood, estate or landmark</span>
        </label>
        <input
          id="geo-area-input"
          className="input"
          value={value.area}
          onChange={(event) => onChange({ ...value, area: event.target.value })}
          onBlur={() => {
            remember();
          }}
          placeholder="e.g. Lekki Phase 1, Victoria Island, Yaba"
        />
      </div>

      {recent.length > 0 ? (
        <div className="geo-recent">
          <span className="tiny strong">Recent</span>
          <div className="geo-chips">
            {recent.map((item) => (
              <button
                key={geoLabel(item)}
                type="button"
                className="geo-chip geo-chip-button"
                onClick={() => onChange(item)}
                title="Use this location"
              >
                {geoLabel(item)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!isGeoEmpty(value) ? (
        <p className="geo-picker-hint">
          Research will be scoped to <strong>{label || value.continent}</strong>.
        </p>
      ) : null}
    </div>
  );
}
