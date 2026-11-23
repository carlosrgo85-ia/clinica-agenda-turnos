import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { BrandHeader } from "../components/BrandHeader";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // La respuesta es siempre "ok", exista o no la cuenta — no revela
      // qué emails están registrados.
      await api.post("/auth/forgot-password", { email });
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  return (
    <div className="auth-page">
      <PageContainer size="auth">
        <div className="card">
          <BrandHeader />
          <h1>Recuperar contraseña</h1>
          {sent ? (
            <p>Si el email existe, te llegó un link para elegir una contraseña nueva.</p>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="field">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Enviando…" : "Enviar link"}
              </Button>
            </form>
          )}
          <p style={{ marginTop: 16 }}>
            <Link to="/login">Volver a iniciar sesión</Link>
          </p>
        </div>
      </PageContainer>
    </div>
  );
}
