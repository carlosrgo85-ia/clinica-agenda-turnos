import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { BrandHeader } from "../components/BrandHeader";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/**
 * Una sola pantalla para elegir contraseña, tanto para una invitación nueva
 * como para "olvidé mi contraseña" — los dos usan el mismo token (ver
 * POST /auth/reset-password).
 */
export function SetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/auth/reset-password", { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo establecer la contraseña");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-page">
        <PageContainer size="auth">
          <div className="card">
            <BrandHeader />
            <p className="error-text">Falta el token del link. Pedí uno nuevo.</p>
          </div>
        </PageContainer>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-page">
        <PageContainer size="auth">
          <div className="card">
            <BrandHeader />
            <p>Contraseña establecida. Ya puedes iniciar sesión.</p>
            <Link to="/login">Ir a iniciar sesión</Link>
          </div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <PageContainer size="auth">
        <form className="card" onSubmit={handleSubmit}>
          <BrandHeader />
          <h1>Elige tu contraseña</h1>
          <div className="field">
            <Label htmlFor="password">Contraseña nueva</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className="muted">Mínimo 8 caracteres.</span>
          </div>
          {error && <p className="error-text">{error}</p>}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Guardando…" : "Guardar contraseña"}
          </Button>
        </form>
      </PageContainer>
    </div>
  );
}
