import { useEffect, useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Checkbox } from "../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusBadge } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog";

interface RoleSummary {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  active: boolean;
  roles: { role: RoleSummary }[];
}

export function UsersPage() {
  const clinicId = useEffectiveClinicId();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const [usersData, rolesData] = await Promise.all([
        api.get<UserRow[]>(`/dashboard/clinics/${clinicId}/users`),
        api.get<RoleSummary[]>(`/dashboard/clinics/${clinicId}/roles`),
      ]);
      setUsers(usersData);
      setRoles(rolesData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista de usuarios");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) {
    return <ClinicScopeRequired />;
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post(`/dashboard/clinics/${clinicId}/users`, { email, name, roleIds: selectedRoleIds });
      setEmail("");
      setName("");
      setSelectedRoleIds([]);
      toast.success(`Se invitó a ${email} por email.`);
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo crear el usuario";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function deactivate(u: UserRow) {
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/users/${u.id}`);
      toast.success(`${u.name} fue desactivado.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo desactivar el usuario");
    }
  }

  async function reactivate(u: UserRow) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/users/${u.id}`, { active: true });
      toast.success(`${u.name} fue reactivado.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo reactivar el usuario");
    }
  }

  return (
    <div>
      <h1>Usuarios</h1>

      <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
        <form className="card" onSubmit={handleCreate}>
          <h2>Nuevo usuario</h2>
          <div className="field">
            <Label htmlFor="new-email">Email</Label>
            <Input id="new-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <Label htmlFor="new-name">Nombre</Label>
            <Input id="new-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <Label>Roles</Label>
            {roles.map((role) => (
              <div className="checkbox-field" key={role.id}>
                <Checkbox
                  id={`role-${role.id}`}
                  checked={selectedRoleIds.includes(role.id)}
                  onCheckedChange={(checked) =>
                    setSelectedRoleIds((prev) =>
                      checked ? [...prev, role.id] : prev.filter((id) => id !== role.id)
                    )
                  }
                />
                <Label htmlFor={`role-${role.id}`}>{role.name}</Label>
              </div>
            ))}
          </div>
          {formError && <p className="error-text">{formError}</p>}
          <Button type="submit" disabled={submitting} style={{ marginTop: 12 }}>
            <UserPlus size={16} />
            {submitting ? "Creando…" : "Crear e invitar por email"}
          </Button>
        </form>
      </PageContainer>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : users.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="Todavía no hay usuarios"
          description="Crea el primero con el formulario de arriba — le va a llegar una invitación por email."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.name}</TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.roles.map((r) => r.role.name).join(", ") || "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={u.active ? "active" : "inactive"} />
                </TableCell>
                <TableCell>
                  {u.active ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          Desactivar
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>¿Desactivar a {u.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            No va a poder iniciar sesión hasta que lo reactives.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deactivate(u)}>Desactivar</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => reactivate(u)}>
                      Reactivar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
