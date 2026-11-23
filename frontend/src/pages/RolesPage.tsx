import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
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

interface PermissionDef {
  id: string;
  description: string;
  group: string;
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: { permission: PermissionDef }[];
}

export function RolesPage() {
  const clinicId = useEffectiveClinicId();

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [catalog, setCatalog] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPermissionIds, setSelectedPermissionIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const grouped = useMemo(() => {
    const byGroup = new Map<string, PermissionDef[]>();
    for (const p of catalog) {
      if (!byGroup.has(p.group)) byGroup.set(p.group, []);
      byGroup.get(p.group)!.push(p);
    }
    return byGroup;
  }, [catalog]);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const [rolesData, catalogData] = await Promise.all([
        api.get<RoleRow[]>(`/dashboard/clinics/${clinicId}/roles`),
        api.get<PermissionDef[]>(`/dashboard/clinics/${clinicId}/permissions`),
      ]);
      setRoles(rolesData);
      setCatalog(catalogData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista de roles");
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
      await api.post(`/dashboard/clinics/${clinicId}/roles`, {
        name,
        description: description || undefined,
        permissionIds: selectedPermissionIds,
      });
      toast.success(`Rol "${name}" creado.`);
      setName("");
      setDescription("");
      setSelectedPermissionIds([]);
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo crear el rol";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(role: RoleRow) {
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/roles/${role.id}`);
      toast.success(`Rol "${role.name}" borrado.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar el rol");
    }
  }

  return (
    <div>
      <h1>Roles</h1>

      <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
        <form className="card" onSubmit={handleCreate}>
          <h2>Nuevo rol</h2>
          <div className="field">
            <Label htmlFor="role-name">Nombre</Label>
            <Input id="role-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <Label htmlFor="role-description">Descripción</Label>
            <Input id="role-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {[...grouped.entries()].map(([group, permissions]) => (
            <div className="field" key={group}>
              <h4 style={{ margin: "8px 0 4px" }}>{group}</h4>
              {permissions.map((permission) => (
                <div className="checkbox-field" key={permission.id}>
                  <Checkbox
                    id={`perm-${permission.id}`}
                    checked={selectedPermissionIds.includes(permission.id)}
                    onCheckedChange={(checked) =>
                      setSelectedPermissionIds((prev) =>
                        checked ? [...prev, permission.id] : prev.filter((id) => id !== permission.id)
                      )
                    }
                  />
                  <Label htmlFor={`perm-${permission.id}`}>{permission.description}</Label>
                </div>
              ))}
            </div>
          ))}
          {formError && <p className="error-text">{formError}</p>}
          <Button type="submit" disabled={submitting} style={{ marginTop: 12 }}>
            {submitting ? "Creando…" : "Crear rol"}
          </Button>
        </form>
      </PageContainer>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : roles.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Todavía no hay roles"
          description="Crea el primero con el formulario de arriba, combinando los permisos que necesite."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Permisos</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {role.name}
                  {role.isSystem && <StatusBadge status="system" />}
                </TableCell>
                <TableCell>{role.permissions.length}</TableCell>
                <TableCell>
                  {!role.isSystem && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          Borrar
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>¿Borrar el rol "{role.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Los usuarios que lo tengan asignado pierden esos permisos. No se puede deshacer.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(role)}>Borrar</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
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
