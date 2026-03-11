"use client";

import { useEffect, useState, useCallback } from "react";
import { getProfile, updateProfile } from "@/lib/api";
import { BUSINESS_CATEGORIES } from "@/lib/types";
import type { BusinessProfile } from "@/lib/types";
import { HoursEditor } from "@/components/HoursEditor";
import { Save, Check, AlertCircle, X } from "lucide-react";

type Toast = { type: "success" | "error"; message: string } | null;

export default function ProfilePage() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  // Form state
  const [businessName, setBusinessName] = useState("");
  const [handle, setHandle] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [supportUrl, setSupportUrl] = useState("");
  const [operatingHours, setOperatingHours] = useState<Record<
    string,
    string
  > | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<string[]>([]);
  const [newPayment, setNewPayment] = useState("");

  const populateForm = useCallback((p: BusinessProfile) => {
    setBusinessName(p.business_name);
    setHandle(p.handle ?? "");
    setCategory(p.category);
    setDescription(p.description);
    setWebsite(p.website);
    setLogoUrl(p.logo_url ?? "");
    setAddress(p.location?.address ?? "");
    setCity(p.location?.city ?? "");
    setState(p.location?.state ?? "");
    setCountry(p.location?.country ?? "");
    setPostalCode(p.location?.postal_code ?? "");
    setEmail(p.contact?.email ?? "");
    setPhone(p.contact?.phone ?? "");
    setSupportUrl(p.contact?.support_url ?? "");
    setOperatingHours(p.operating_hours);
    setPaymentMethods(p.payment_methods ?? []);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const p = await getProfile();
        setProfile(p);
        populateForm(p);
      } catch (err) {
        console.error("Failed to load profile:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [populateForm]);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setToast(null);

    try {
      const data: Partial<BusinessProfile> = {
        business_name: businessName,
        handle: handle || null,
        category,
        description,
        website,
        logo_url: logoUrl || null,
        location: {
          address: address || undefined,
          city: city || undefined,
          state: state || undefined,
          country: country || undefined,
          postal_code: postalCode || undefined,
        },
        contact: {
          email: email || undefined,
          phone: phone || undefined,
          support_url: supportUrl || undefined,
        },
        operating_hours: operatingHours,
        payment_methods: paymentMethods,
      };

      const updated = await updateProfile(data);
      setProfile(updated);
      populateForm(updated);
      setToast({ type: "success", message: "Profile saved successfully." });
    } catch (err) {
      setToast({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to save profile.",
      });
    } finally {
      setSaving(false);
    }
  }

  function addPaymentMethod() {
    const method = newPayment.trim();
    if (method && !paymentMethods.includes(method)) {
      setPaymentMethods([...paymentMethods, method]);
      setNewPayment("");
    }
  }

  function removePaymentMethod(method: string) {
    setPaymentMethods(paymentMethods.filter((m) => m !== method));
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-gray-800" />
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-3">
            <div className="h-5 w-32 animate-pulse rounded bg-gray-800" />
            <div className="h-10 animate-pulse rounded-lg bg-gray-800" />
            <div className="h-10 animate-pulse rounded-lg bg-gray-800" />
          </div>
        ))}
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
        <p className="text-red-400">
          Failed to load profile. Please try refreshing.
        </p>
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-gray-50 placeholder-gray-500 focus:border-said-500 focus:outline-none transition-colors";
  const labelClass = "block text-sm font-medium text-gray-300 mb-1.5";

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Edit Profile</h1>
      <p className="mt-1 mb-8 text-gray-400">
        Update your business information that AI agents will use to understand
        your identity.
      </p>

      {/* Toast */}
      {toast && (
        <div
          className={`mb-6 flex items-center gap-3 rounded-xl border px-4 py-3 ${
            toast.type === "success"
              ? "border-green-600/30 bg-green-500/10 text-green-300"
              : "border-red-600/30 bg-red-500/10 text-red-300"
          }`}
        >
          {toast.type === "success" ? (
            <Check className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="text-sm">{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            className="ml-auto text-gray-400 hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-10">
        {/* Basic Info */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white border-b border-gray-800 pb-2">
            Basic Info
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="business_name" className={labelClass}>
                Business Name
              </label>
              <input
                id="business_name"
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className={inputClass}
                required
              />
            </div>
            <div>
              <label htmlFor="handle" className={labelClass}>
                Handle
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                  @
                </span>
                <input
                  id="handle"
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className={`${inputClass} pl-7`}
                  placeholder="yourhandle"
                />
              </div>
            </div>
            <div>
              <label htmlFor="category" className={labelClass}>
                Category
              </label>
              <select
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">Select a category</option>
                {BUSINESS_CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="description" className={labelClass}>
                Description
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className={`${inputClass} resize-none`}
                placeholder="Describe your business for AI agents..."
              />
            </div>
          </div>
        </section>

        {/* Website & Logo */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white border-b border-gray-800 pb-2">
            Website & Logo
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="website" className={labelClass}>
                Website
              </label>
              <input
                id="website"
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className={inputClass}
                placeholder="https://example.com"
              />
            </div>
            <div>
              <label htmlFor="logo_url" className={labelClass}>
                Logo URL
              </label>
              <input
                id="logo_url"
                type="url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                className={inputClass}
                placeholder="https://example.com/logo.png"
              />
            </div>
          </div>
        </section>

        {/* Location */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white border-b border-gray-800 pb-2">
            Location
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <label htmlFor="address" className={labelClass}>
                Address
              </label>
              <input
                id="address"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className={inputClass}
                placeholder="123 Main St"
              />
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
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="state" className={labelClass}>
                State / Province
              </label>
              <input
                id="state"
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="country" className={labelClass}>
                Country
              </label>
              <input
                id="country"
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="postal_code" className={labelClass}>
                Postal Code
              </label>
              <input
                id="postal_code"
                type="text"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        </section>

        {/* Contact */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white border-b border-gray-800 pb-2">
            Contact
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="contact_email" className={labelClass}>
                Email
              </label>
              <input
                id="contact_email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                placeholder="contact@example.com"
              />
            </div>
            <div>
              <label htmlFor="phone" className={labelClass}>
                Phone
              </label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className={inputClass}
                placeholder="+1 (555) 000-0000"
              />
            </div>
            <div>
              <label htmlFor="support_url" className={labelClass}>
                Support URL
              </label>
              <input
                id="support_url"
                type="url"
                value={supportUrl}
                onChange={(e) => setSupportUrl(e.target.value)}
                className={inputClass}
                placeholder="https://example.com/support"
              />
            </div>
          </div>
        </section>

        {/* Operating Hours */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white border-b border-gray-800 pb-2">
            Operating Hours
          </h2>
          <HoursEditor value={operatingHours} onChange={setOperatingHours} />
        </section>

        {/* Payment Methods */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white border-b border-gray-800 pb-2">
            Payment Methods
          </h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {paymentMethods.map((method) => (
              <span
                key={method}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-700 bg-gray-800 px-3 py-1 text-sm text-gray-300"
              >
                {method}
                <button
                  type="button"
                  onClick={() => removePaymentMethod(method)}
                  className="text-gray-500 hover:text-red-400 transition-colors cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            {paymentMethods.length === 0 && (
              <p className="text-sm text-gray-500">
                No payment methods added yet.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPayment}
              onChange={(e) => setNewPayment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPaymentMethod();
                }
              }}
              className={`${inputClass} max-w-xs`}
              placeholder="e.g. Visa, PayPal, USDC..."
            />
            <button
              type="button"
              onClick={addPaymentMethod}
              className="shrink-0 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700 hover:text-white transition-colors cursor-pointer"
            >
              Add
            </button>
          </div>
        </section>

        {/* Save button */}
        <div className="flex justify-end border-t border-gray-800 pt-6">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-said-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-said-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {saving ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Save Profile
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
