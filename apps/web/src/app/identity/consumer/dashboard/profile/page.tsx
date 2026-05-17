"use client";

import { useEffect, useState, useCallback, type FormEvent } from "react";
import { getConsumerProfile, updateConsumerProfile } from "@/lib/api";
import type { PublicProfile, AgentPreferences, GeoHint } from "@/lib/types";
import { Save, X, Plus, Loader2 } from "lucide-react";

const COMMUNICATION_STYLES = [
  { value: "", label: "Select a style" },
  { value: "casual", label: "Casual" },
  { value: "formal", label: "Formal" },
  { value: "technical", label: "Technical" },
  { value: "concise", label: "Concise" },
];

const RESPONSE_FORMATS = [
  { value: "", label: "Select a format" },
  { value: "detailed", label: "Detailed" },
  { value: "bullet_points", label: "Bullet Points" },
  { value: "conversational", label: "Conversational" },
];

const COMMON_TIMEZONES = [
  { value: "", label: "Select timezone" },
  { value: "America/New_York", label: "Eastern Time (US)" },
  { value: "America/Chicago", label: "Central Time (US)" },
  { value: "America/Denver", label: "Mountain Time (US)" },
  { value: "America/Los_Angeles", label: "Pacific Time (US)" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
  { value: "America/Toronto", label: "Eastern Time (Canada)" },
  { value: "America/Vancouver", label: "Pacific Time (Canada)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Central European" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Shanghai", label: "China Standard" },
  { value: "Asia/Kolkata", label: "India Standard" },
  { value: "Asia/Dubai", label: "Gulf Standard" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Australia/Sydney", label: "Sydney (AEST)" },
  { value: "Pacific/Auckland", label: "New Zealand" },
  { value: "America/Sao_Paulo", label: "Brasilia" },
  { value: "Africa/Johannesburg", label: "South Africa" },
];

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");

  function addTag() {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-[#3da8ff]/10 px-2.5 py-1 text-xs font-medium text-[#3da8ff] border border-[#3da8ff]/20"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-[#3da8ff]/60 hover:text-[#3da8ff] cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors"
        />
        <button
          type="button"
          onClick={addTag}
          className="rounded-lg bg-[#161822] px-3 py-2 text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function ConsumerProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  // Identity fields
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");

  // Location fields
  const [timezone, setTimezone] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");

  // Agent preferences
  const [communicationStyle, setCommunicationStyle] = useState("");
  const [responseFormat, setResponseFormat] = useState("");
  const [expertiseAreas, setExpertiseAreas] = useState<string[]>([]);
  const [dietaryRestrictions, setDietaryRestrictions] = useState<string[]>([]);
  const [accessibilityNeeds, setAccessibilityNeeds] = useState<string[]>([]);

  const populateForm = useCallback((p: PublicProfile) => {
    setDisplayName(p.display_name || "");
    setHandle(p.handle || "");
    setAvatarUrl(p.avatar_url || "");
    setBio(p.bio || "");
    setTimezone(p.timezone || "");
    setCity(p.agent_preferences.location?.city || "");
    setRegion(p.agent_preferences.location?.region || "");
    setCountry(p.agent_preferences.location?.country || "");
    setCommunicationStyle(p.agent_preferences.communication_style || "");
    setResponseFormat(p.agent_preferences.response_format || "");
    setExpertiseAreas(p.agent_preferences.expertise_areas || []);
    setDietaryRestrictions(p.agent_preferences.dietary_restrictions || []);
    setAccessibilityNeeds(p.agent_preferences.accessibility_needs || []);
  }, []);

  useEffect(() => {
    getConsumerProfile()
      .then(populateForm)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [populateForm]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess(false);
    setSaving(true);

    const location: GeoHint = {};
    if (city) location.city = city;
    if (region) location.region = region;
    if (country) location.country = country;
    if (timezone) location.timezone = timezone;

    const agent_preferences: AgentPreferences = {
      expertise_areas: expertiseAreas,
      dietary_restrictions: dietaryRestrictions,
      accessibility_needs: accessibilityNeeds,
      custom: {},
    };
    if (communicationStyle) agent_preferences.communication_style = communicationStyle;
    if (responseFormat) agent_preferences.response_format = responseFormat;
    if (Object.keys(location).length > 0) agent_preferences.location = location;

    try {
      const updated = await updateConsumerProfile({
        display_name: displayName,
        handle: handle || null,
        avatar_url: avatarUrl || null,
        bio: bio || null,
        timezone: timezone || null,
        agent_preferences,
      });
      populateForm(updated);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#3da8ff] border-t-transparent" />
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-[#1e2a3a] bg-[#0f1117] px-4 py-2.5 text-sm text-[#eef1f8] placeholder-[#4a5568] focus:border-[#3da8ff] focus:ring-1 focus:ring-[#3da8ff] outline-none transition-colors";
  const labelClass = "block text-sm font-medium text-[#8b95a8] mb-1.5";
  const sectionHeadingClass =
    "text-xs font-semibold uppercase tracking-wider text-[#4a5568] mb-4";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-medium text-[#eef1f8]">My Profile</h1>
        <p className="mt-1 text-[#8b95a8]">
          Configure how AI agents see and interact with you.
        </p>
      </div>

      {/* Feedback */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
          Profile saved successfully.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Identity section */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <p className={sectionHeadingClass}>Identity</p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="display-name" className={labelClass}>
                Display Name
              </label>
              <input
                id="display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="handle" className={labelClass}>
                Handle
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-sm text-[#4a5568]">
                  @
                </span>
                <input
                  id="handle"
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="yourhandle"
                  className={`${inputClass} pl-8`}
                />
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="avatar-url" className={labelClass}>
                Avatar URL
              </label>
              <input
                id="avatar-url"
                type="url"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://example.com/avatar.jpg"
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="bio" className={labelClass}>
                Bio
              </label>
              <textarea
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="A short description about yourself..."
                rows={3}
                className={`${inputClass} resize-none`}
              />
            </div>
          </div>
        </div>

        {/* Location section */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <p className={sectionHeadingClass}>Location</p>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="timezone" className={labelClass}>
                Timezone
              </label>
              <select
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className={`${inputClass} appearance-none cursor-pointer`}
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="city" className={labelClass}>
                City
              </label>
              <input
                id="city"
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="San Francisco"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="region" className={labelClass}>
                Region / State
              </label>
              <input
                id="region"
                type="text"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="California"
                className={inputClass}
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="country" className={labelClass}>
                Country
              </label>
              <input
                id="country"
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="United States"
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Agent Preferences section */}
        <div className="rounded-xl border border-[#1e2a3a] bg-[#0f1117] p-6">
          <p className={sectionHeadingClass}>Agent Preferences</p>
          <p className="text-xs text-[#4a5568] mb-5">
            These preferences are shared with AI services you connect to, so they can personalize your experience.
          </p>
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="communication-style" className={labelClass}>
                  Communication Style
                </label>
                <select
                  id="communication-style"
                  value={communicationStyle}
                  onChange={(e) => setCommunicationStyle(e.target.value)}
                  className={`${inputClass} appearance-none cursor-pointer`}
                >
                  {COMMUNICATION_STYLES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="response-format" className={labelClass}>
                  Response Format
                </label>
                <select
                  id="response-format"
                  value={responseFormat}
                  onChange={(e) => setResponseFormat(e.target.value)}
                  className={`${inputClass} appearance-none cursor-pointer`}
                >
                  {RESPONSE_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className={labelClass}>Expertise Areas</label>
              <TagInput
                tags={expertiseAreas}
                onChange={setExpertiseAreas}
                placeholder="Add an area of expertise..."
              />
            </div>

            <div>
              <label className={labelClass}>Dietary Restrictions</label>
              <TagInput
                tags={dietaryRestrictions}
                onChange={setDietaryRestrictions}
                placeholder="e.g. vegetarian, gluten-free..."
              />
            </div>

            <div>
              <label className={labelClass}>Accessibility Needs</label>
              <TagInput
                tags={accessibilityNeeds}
                onChange={setAccessibilityNeeds}
                placeholder="e.g. screen reader, high contrast..."
              />
            </div>
          </div>
        </div>

        {/* Save button */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[#3da8ff] px-6 py-2.5 text-sm font-semibold text-[#eef1f8] hover:bg-[#5bb8ff] disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "Saving..." : "Save Profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
