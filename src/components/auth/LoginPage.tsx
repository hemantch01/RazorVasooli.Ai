import { useState } from "react";
import { Zap, Loader2 } from "lucide-react";

interface LoginPageProps {
  onLogin: (user: { email: string; name: string }) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("admin@razorvasooli.in");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { email, password, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Authentication failed");
        return;
      }
      onLogin(data.user);
    } catch {
      setError("Backend unreachable — is `npm run server` running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-orange/20 to-brand-peach/30 flex items-center justify-center border border-brand-orange/20">
            <Zap className="w-6 h-6 text-brand-orange" />
          </div>
          <div>
            <h1 className="text-xl font-bold font-heading text-slate-900">RazorVasooli.Ai</h1>
            <p className="text-[11px] font-body text-slate-400 font-semibold tracking-wider uppercase">
              AI Revenue Recovery Command Center
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-2xl bg-white border border-slate-200 shadow-sm p-7 space-y-4"
        >
          <div className="flex rounded-xl bg-slate-100 p-1">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); }}
                className={`flex-1 py-2 rounded-lg text-xs font-body font-semibold transition-all cursor-pointer ${
                  mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {m === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>

          {mode === "register" && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-body focus:outline-none focus:ring-2 focus:ring-brand-orange/40 focus:border-brand-orange"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-body focus:outline-none focus:ring-2 focus:ring-brand-orange/40 focus:border-brand-orange"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "login" ? "Password" : "Password (min 8 chars)"}
            required
            minLength={mode === "register" ? 8 : undefined}
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-body focus:outline-none focus:ring-2 focus:ring-brand-orange/40 focus:border-brand-orange"
          />

          {error && (
            <p className="text-xs font-body text-red-600 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-xl bg-brand-orange hover:bg-brand-orange/90 text-white text-sm font-body font-bold disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === "login" ? "Sign In to Dashboard" : "Create Account"}
          </button>

          <p className="text-[11px] font-body text-slate-400 text-center leading-relaxed">
            Demo credentials: <code className="font-mono">admin@razorvasooli.in</code> /{" "}
            <code className="font-mono">changeme123</code> (or set ADMIN_EMAIL / ADMIN_PASSWORD in .env)
          </p>
        </form>
      </div>
    </div>
  );
}
