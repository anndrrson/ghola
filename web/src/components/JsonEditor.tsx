"use client";

import { useState, useCallback } from "react";

interface JsonEditorProps {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  label: string;
  placeholder?: string;
}

export function JsonEditor({
  value,
  onChange,
  label,
  placeholder,
}: JsonEditorProps) {
  const [text, setText] = useState(() =>
    Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ""
  );
  const [error, setError] = useState<string | null>(null);

  const handleBlur = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setError(null);
      onChange({});
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("Must be a JSON object");
        return;
      }
      setError(null);
      setText(JSON.stringify(parsed, null, 2));
      onChange(parsed);
    } catch {
      setError("Invalid JSON");
    }
  }, [text, onChange]);

  return (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-1">
        {label}
      </label>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onBlur={handleBlur}
        placeholder={placeholder || '{ "key": "value" }'}
        rows={4}
        className={`w-full rounded-md bg-gray-900 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 border focus:outline-none focus:ring-1 ${
          error
            ? "border-red-500 focus:ring-red-500"
            : "border-gray-700 focus:ring-said-500 focus:border-said-500"
        }`}
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
