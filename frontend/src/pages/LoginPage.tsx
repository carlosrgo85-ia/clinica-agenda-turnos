import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { BrandHeader } from "../components/BrandHeader";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const redirect = searchParams.get("redirect");

  // Ya había sesión (ej. volvió a /login con el back del browser): manda
  // para adelante en vez de mostrar el formulario de nuevo.
  useEffect(() => {
    if (user) goToRedirect(redirect, navigate);
  }, [user, redirect, navigate]);

  if (user) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      goToRedirect(redirect, navigate);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesión");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <PageContainer size="auth">
        <form className="card" onSubmit={handleSubmit}>
          <BrandHeader />
          <h1>Iniciar sesión</h1>
          <div className="field">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <Label htmlFor="password">Contraseña</Label>
            <Input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Ingresando…" : "Ingresar"}
          </Button>
          <p style={{ marginTop: 16 }}>
            <Link to="/forgot-password">Olvidé mi contraseña</Link>
          </p>
        </form>
      </PageContainer>
    </div>
  );
}

/**
 * `redirect` puede ser una ruta DENTRO de la SPA (la arma `RequireAuth` con
 * `location.pathname`, que React Router ya devuelve sin el `basename` — o
 * sea, llega como "/users", nunca "/app/users") o una URL fuera de la SPA
 * (ej. "/ui/?clinicId=..." del banner legacy, que sí necesita el path
 * completo desde la raíz). Solo esta última necesita una navegación de
 * browser completa; toda ruta interna tiene que ir por `navigate()` para
 * que React Router le vuelva a anteponer el `basename`.
 */
function goToRedirect(redirect: string | null, navigate: ReturnType<typeof useNavigate>) {
  if (redirect && redirect.startsWith("/ui")) {
    window.location.href = redirect;
    return;
  }
  navigate(redirect || "/", { replace: true });
}
