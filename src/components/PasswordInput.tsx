"use client";

import { useState } from "react";

/**
 * A password input with a "show/hide" toggle button, since new users
 * mistyping a password with no way to check it is a common source of
 * signup/login friction.
 */
export default function PasswordInput({
  value,
  onChange,
  minLength,
  required = true,
  autoComplete,
  name = "password",
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  required?: boolean;
  autoComplete?: string;
  name?: string;
  id?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <input
        required={required}
        type={visible ? "text" : "password"}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        name={name}
        id={id ?? name}
        className="input"
        style={{ paddingRight: 56 }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        tabIndex={-1}
        style={{
          position: "absolute",
          right: 8,
          top: 8,
          background: "none",
          border: "none",
          padding: "2px 6px",
          fontSize: 12,
          color: "#6b6152",
          cursor: "pointer",
        }}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}
