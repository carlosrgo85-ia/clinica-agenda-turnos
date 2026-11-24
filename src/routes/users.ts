import { Router } from "express";
import { enrichAudit } from "../services/audit";
import { PERMISSIONS } from "../config/permissions";
import { authenticate } from "../middleware/authenticate";
import { requirePermission } from "../middleware/authorize";
import { createUser, listUsersByClinic, updateUserInClinic } from "../repositories/users.repository";
import { roleIdsBelongToClinic } from "../repositories/roles.repository";
import { trySendUserInvitation } from "../services/invitations";
import { prisma } from "../db/client";

export const usersRouter = Router();
usersRouter.use(authenticate);

/** Gestión de usuarios de UNA clínica. El alta de usuarios de plataforma vive en routes/platform.ts. */
usersRouter.get("/clinics/:clinicId/users", requirePermission(PERMISSIONS.USUARIOS_VER), async (req, res) => {
  const users = await listUsersByClinic(req.params.clinicId);
  res.json(users);
});

usersRouter.post(
  "/clinics/:clinicId/users",
  requirePermission(PERMISSIONS.USUARIOS_CREAR),
  async (req, res) => {
    const { clinicId } = req.params;
    const { email, name, roleIds } = req.body ?? {};
    if (typeof email !== "string" || typeof name !== "string" || !Array.isArray(roleIds)) {
      res.status(400).json({ error: "Faltan email, name o roleIds" });
      return;
    }

    if (!(await roleIdsBelongToClinic(roleIds, clinicId))) {
      res.status(400).json({ error: "Alguno de los roles no pertenece a esta clínica" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "Ya existe un usuario con ese email" });
      return;
    }

    const user = await createUser({ clinicId, email, name, roleIds });
    const invitacionEnviada = await trySendUserInvitation(user, clinicId);
    // A quién se dio de alta y con qué roles: los roles son los permisos que recibe.
    enrichAudit(res, { resourceId: user.id, details: { emailDelUsuario: email, roles: roleIds } });

    res.status(201).json({ ...user, invitacionEnviada });
  }
);

usersRouter.put(
  "/clinics/:clinicId/users/:userId",
  requirePermission(PERMISSIONS.USUARIOS_EDITAR),
  async (req, res) => {
    const { clinicId, userId } = req.params;
    const { name, active, roleIds } = req.body ?? {};

    if (roleIds !== undefined) {
      if (!Array.isArray(roleIds) || !(await roleIdsBelongToClinic(roleIds, clinicId))) {
        res.status(400).json({ error: "roleIds inválido o con roles de otra clínica" });
        return;
      }
    }

    const updated = await updateUserInClinic({ id: userId, clinicId, name, active, roleIds });
    if (!updated) {
      res.status(404).json({ error: "Usuario no encontrado en esta clínica" });
      return;
    }

    enrichAudit(res, {
      details: {
        ...(roleIds !== undefined ? { roles: roleIds } : {}),
        ...(typeof active === "boolean" ? { activo: active } : {}),
      },
    });
    res.json(updated);
  }
);

usersRouter.delete(
  "/clinics/:clinicId/users/:userId",
  requirePermission(PERMISSIONS.USUARIOS_ELIMINAR),
  async (req, res) => {
    const { clinicId, userId } = req.params;
    const updated = await updateUserInClinic({ id: userId, clinicId, active: false });
    if (!updated) {
      res.status(404).json({ error: "Usuario no encontrado en esta clínica" });
      return;
    }
    res.json(updated);
  }
);

