import { Router } from "express";
import { enrichAudit } from "../services/audit";
import { PERMISSION_CATALOG, PERMISSIONS, PLATFORM_ONLY_PERMISSIONS } from "../config/permissions";
import { authenticate } from "../middleware/authenticate";
import { requirePermission } from "../middleware/authorize";
import { createRole, deleteRoleInClinic, listRolesByClinic, updateRoleInClinic } from "../repositories/roles.repository";
import { prisma } from "../db/client";

export const rolesRouter = Router();
rolesRouter.use(authenticate);

/** Catálogo de permisos disponibles para armar roles, agrupado para la UI. */
rolesRouter.get(
  "/clinics/:clinicId/permissions",
  requirePermission(PERMISSIONS.ROLES_VER),
  (_req, res) => {
    const asignables = PERMISSION_CATALOG.filter(
      (p) => !PLATFORM_ONLY_PERMISSIONS.includes(p.id)
    );
    res.json(asignables);
  }
);

rolesRouter.get("/clinics/:clinicId/roles", requirePermission(PERMISSIONS.ROLES_VER), async (req, res) => {
  const roles = await listRolesByClinic(req.params.clinicId);
  res.json(roles);
});

rolesRouter.post(
  "/clinics/:clinicId/roles",
  requirePermission(PERMISSIONS.ROLES_GESTIONAR),
  async (req, res) => {
    const { clinicId } = req.params;
    const { name, description, permissionIds } = req.body ?? {};
    if (typeof name !== "string" || !Array.isArray(permissionIds)) {
      res.status(400).json({ error: "Faltan name o permissionIds" });
      return;
    }
    if (permissionIds.some((id) => PLATFORM_ONLY_PERMISSIONS.includes(id))) {
      res.status(400).json({ error: "Un rol de clínica no puede tener permisos de plataforma" });
      return;
    }

    const existing = await prisma.role.findFirst({ where: { clinicId, name } });
    if (existing) {
      res.status(409).json({ error: "Ya existe un rol con ese nombre en esta clínica" });
      return;
    }

    const role = await createRole({ clinicId, name, description, permissionIds });
    // Los permisos de un rol son lo más delicado que se puede cambiar: acá SÍ se
    // registra cuáles (son ids de un catálogo fijo, no datos de nadie).
    enrichAudit(res, { resourceId: role.id, details: { nombreDelRol: name, permisos: permissionIds } });
    res.status(201).json(role);
  }
);

rolesRouter.put(
  "/clinics/:clinicId/roles/:roleId",
  requirePermission(PERMISSIONS.ROLES_GESTIONAR),
  async (req, res) => {
    const { clinicId, roleId } = req.params;
    const { name, description, permissionIds } = req.body ?? {};

    if (permissionIds !== undefined) {
      if (!Array.isArray(permissionIds) || permissionIds.some((id) => PLATFORM_ONLY_PERMISSIONS.includes(id))) {
        res.status(400).json({ error: "permissionIds inválido o con permisos de plataforma" });
        return;
      }
    }

    const updated = await updateRoleInClinic({ id: roleId, clinicId, name, description, permissionIds });
    if (!updated) {
      res.status(404).json({ error: "Rol no encontrado en esta clínica" });
      return;
    }
    if (permissionIds !== undefined) enrichAudit(res, { details: { permisos: permissionIds } });
    res.json(updated);
  }
);

rolesRouter.delete(
  "/clinics/:clinicId/roles/:roleId",
  requirePermission(PERMISSIONS.ROLES_GESTIONAR),
  async (req, res) => {
    const { clinicId, roleId } = req.params;
    const deleted = await deleteRoleInClinic(roleId, clinicId);
    if (!deleted) {
      res.status(404).json({ error: "Rol no encontrado, de otra clínica, o es un rol de sistema" });
      return;
    }
    res.status(204).end();
  }
);
