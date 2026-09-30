"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const supabase = createClient();
  const [businessName, setBusinessName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { business_name: businessName, full_name: fullName },
      },
    });

    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    // The handle_new_user() DB trigger creates the organization, profile and
    // seeds the Pricing Book the moment this signup lands.
    //
    // Whether we get a live session back depends on the Supabase project's
    // "Confirm email" setting: if it's off, signUp() logs the user straight
    // in and we can go to the dashboard now. If it's on (Supabase's default),
    // there's no session yet — the user must click the link in their
    // confirmation email first, and redirecting to /dashboard here would
    // just bounce them straight back out to /login with an empty form.
    if (data.session) {
      router.push("/dashboard");
      router.refresh();
    } else {
      setCheckEmail(true);
    }
  }

  if (checkEmail) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-sm w-full bg-paper-raised border border-line-strong rounded-lg p-8 text-center">
          <h1 className="font-display text-2xl font-semibold mb-3">Check your email</h1>
          <p className="text-sm text-ink-soft">
            We&apos;ve sent a confirmation link to <strong>{email}</strong>. Click it to activate your
            account, then come back and log in.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <form
        onSubmit={handleSubmit}
        className="max-w-sm w-full bg-paper-raised border border-line-strong rounded-lg p-8"
      >
        <h1 className="font-display text-2xl font-semibold mb-1">Start your free trial</h1>
        <p className="text-xs text-ink-soft mb-6">14 days, no card required.</p>

        <Field label="Business name">
          <input
            required
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className="input"
            placeholder="Your joinery business"
          />
        </Field>
        <Field label="Your name">
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Email">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Password">
          <input
            required
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </Field>

        {error && <p className="text-brick text-sm mb-4">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-brass hover:bg-brass-deep text-white rounded-md py-2.5 font-medium disabled:opacity-50"
        >
          {loading ? "Creating your account…" : "Create account"}
        </button>

        <p className="text-xs text-ink-soft mt-4 text-center">
          Already have an account?{" "}
          <a href="/login" className="text-brass-deep underline">
            Log in
          </a>
        </p>
      </form>

      <style jsx global>{`
        .input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #b9ac94;
          border-radius: 4px;
          background: #faf9f5;
          font-size: 13.5px;
          margin-bottom: 14px;
        }
        .input:focus {
          outline: 2px solid #2f6fb0;
          outline-offset: 1px;
        }
      `}</style>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-1">
      <span className="block text-xs text-ink-soft mb-1 font-medium">{label}</span>
      {children}
    </label>
  );
}
