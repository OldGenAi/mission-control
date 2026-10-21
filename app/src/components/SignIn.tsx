// Shown when the built UI is opened without a session (a bookmark after the session
// ran out, or a copied address). Signing in always goes through the launcher, which
// is the only thing allowed to hand out a one-time link.
export function SignIn() {
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{
        maxWidth: 420, padding: "28px 32px", borderRadius: 12, textAlign: "center",
        background: "var(--card)", border: "1px solid var(--border-strong)",
      }}>
        <div style={{ color: "var(--text-strong)", fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
          Mission Control is running
        </div>
        <p style={{ margin: 0 }}>
          This window isn't signed in yet. Open Mission Control from its icon on your desktop and it will sign you in.
        </p>
      </div>
    </div>
  )
}
