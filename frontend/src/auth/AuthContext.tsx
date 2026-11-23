import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";

export interface SessionUser {
  id: string;
  clinicId: string | null;
  email: string;
  name: string;
  permissions: string[];
}

export interface ViewingClinic {
  id: string;
  name: string;
}

const VIEWING_CLINIC_STORAGE_KEY = "viewingClinic";

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  /** Clínica que un super-admin eligió mirar desde "Clínicas" — null para un usuario de clínica. */
  viewingClinic: ViewingClinic | null;
  setViewingClinic: (clinic: ViewingClinic) => void;
  clearViewingClinic: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredViewingClinic(): ViewingClinic | null {
  try {
    const raw = sessionStorage.getItem(VIEWING_CLINIC_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ViewingClinic) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewingClinic, setViewingClinicState] = useState<ViewingClinic | null>(readStoredViewingClinic);

  useEffect(() => {
    api
      .get<SessionUser>("/auth/me")
      .then(setUser)
      .catch((error) => {
        if (!(error instanceof ApiError && error.status === 401)) {
          console.error("No se pudo verificar la sesión:", error);
        }
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const loggedInUser = await api.post<SessionUser>("/auth/login", { email, password });
    setUser(loggedInUser);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setUser(null);
    setViewingClinicState(null);
    sessionStorage.removeItem(VIEWING_CLINIC_STORAGE_KEY);
  }, []);

  const hasPermission = useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user]
  );

  const setViewingClinic = useCallback((clinic: ViewingClinic) => {
    setViewingClinicState(clinic);
    sessionStorage.setItem(VIEWING_CLINIC_STORAGE_KEY, JSON.stringify(clinic));
  }, []);

  const clearViewingClinic = useCallback(() => {
    setViewingClinicState(null);
    sessionStorage.removeItem(VIEWING_CLINIC_STORAGE_KEY);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, hasPermission, viewingClinic, setViewingClinic, clearViewingClinic }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth se tiene que usar dentro de <AuthProvider>");
  return ctx;
}

/**
 * La clínica sobre la que tiene que operar la pantalla actual: la propia
 * para un usuario de clínica, o la que un super-admin eligió "ver" desde
 * "Clínicas" — null si es super-admin y todavía no eligió ninguna. Las
 * pantallas por clínica (Turnos, Horarios, Usuarios, Métricas, etc.) usan
 * esto en vez de `user.clinicId` directamente, así les sirven tanto a un
 * admin de clínica como a un super-admin que entró a revisar una en
 * particular.
 */
export function useEffectiveClinicId(): string | null {
  const { user, viewingClinic } = useAuth();
  return user?.clinicId ?? viewingClinic?.id ?? null;
}
