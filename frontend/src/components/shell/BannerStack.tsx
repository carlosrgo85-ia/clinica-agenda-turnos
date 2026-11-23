import { useEffect, useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/client";
import { Banner } from "./Banner";
import { Button } from "../ui/button";

const SECRETS_PATH = "/platform/catalogs/secrets";

interface SecretAlert {
  key: string;
  label: string;
  state: "por_vencer" | "vencido";
  resumen: string;
}

/**
 * Avisa que vence (o venció) un secreto de la plataforma. Solo lo ve el
 * super-admin —`BannerStack` ya devuelve null para un usuario de clínica— a
 * propósito: el secreto es de la plataforma, una clínica no puede renovarlo y
 * el aviso solo la alarmaría. A la clínica le llega, si pasa, la
 * consecuencia que sí entiende: su cuenta de Outlook figura como revocada.
 *
 * **No se puede cerrar**, a diferencia de `<Banner>`: un aviso que se
 * descarta una vez y no vuelve es justo lo que no sirve acá. Se va cuando se
 * registra la fecha del secreto nuevo. Se vuelve a consultar al navegar, así
 * desaparece al salir de la pantalla donde se cargó.
 *
 * Es solo un aviso: si la consulta falla no muestra nada ni rompe la pantalla.
 */
function SecretExpiryBanner() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [alerts, setAlerts] = useState<SecretAlert[]>([]);
  const allowed = hasPermission("secretos.ver");

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    api
      .get<{ secretos: Array<{ key: string; label: string; state: string | null; resumen: string | null }> }>(
        "/platform/secrets"
      )
      .then((data) => {
        if (cancelled) return;
        setAlerts(
          data.secretos
            .filter((s) => s.state === "por_vencer" || s.state === "vencido")
            .map((s) => ({ key: s.key, label: s.label, state: s.state as SecretAlert["state"], resumen: s.resumen ?? "" }))
        );
      })
      .catch(() => {
        if (!cancelled) setAlerts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, pathname]);

  // En la propia pantalla del secreto el aviso sobra: ya está todo a la vista.
  if (pathname.startsWith(SECRETS_PATH)) return null;

  return (
    <>
      {alerts.map((alert) => (
        <div key={alert.key} className="banner banner--danger" role="alert">
          <div className="banner-message">
            <KeyRound size={16} />
            <span>
              <strong>{alert.label}</strong> {alert.resumen}.
              {alert.state === "vencido" && " Las clínicas no pueden conectar su Outlook hasta renovarlo."}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate(SECRETS_PATH)}>
            Ver
          </Button>
        </div>
      ))}
    </>
  );
}

/**
 * Pila de banners contextuales sobre el contenido. Un super-admin ve uno
 * de dos: el genérico, o (si eligió "Entrar a esta clínica" desde
 * "Clínicas") uno con el nombre de esa clínica y una salida — este último
 * no usa `<Banner id=...>` porque esa envoltura es para avisos que se
 * cierran una vez y no vuelven, y acá el botón es una acción real
 * ("Volver a Clínicas"), no un descarte.
 */
export function BannerStack() {
  const { user, viewingClinic, clearViewingClinic } = useAuth();
  const navigate = useNavigate();

  if (!user || user.clinicId !== null) return null;

  return (
    <div className="banner-stack">
      <SecretExpiryBanner />
      {viewingClinic ? (
        <div className="banner" role="status">
          <div className="banner-message">
            <ShieldAlert size={16} />
            <span>
              Viendo la clínica <strong>{viewingClinic.name}</strong> como Super Admin.
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              clearViewingClinic();
              navigate("/platform/clinics");
            }}
          >
            Volver a Clínicas
          </Button>
        </div>
      ) : (
        <Banner id="super-admin-mode">
          <ShieldAlert size={16} />
          <span>Estás como Super Admin — estas pantallas muestran datos de toda la plataforma.</span>
        </Banner>
      )}
    </div>
  );
}
