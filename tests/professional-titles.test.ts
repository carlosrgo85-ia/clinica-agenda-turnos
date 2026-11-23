import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  listClinicTitleIds,
  listTitlesForClinic,
  setClinicTitles,
  updateTitle,
} from "../src/repositories/professional-titles.repository";

/**
 * El catálogo de títulos de profesional ("Dr.", "Lic.", "Manicurista").
 *
 * Es global de la plataforma y se habilita por clínica. Lo que se testea acá
 * son las dos bajas que NO se permiten, porque son las que dejarían una ficha
 * mostrando un título que el desplegable ya no ofrece — y entonces sin forma
 * de corregirla desde la interfaz.
 */

const clinicIds: string[] = [];
const titleIds: string[] = [];

async function crearClinica() {
  const sufijo = `${Date.now()}-${Math.random()}`;
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica títulos ${sufijo}`,
      whatsappPhoneNumberId: `titulos-${sufijo}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "titulos@example.com",
      timezone: "UTC",
      services: "Consulta",
    },
  });
  clinicIds.push(clinic.id);
  return clinic;
}

async function crearTitulo(name: string) {
  const title = await prisma.professionalTitle.create({
    data: { name: `${name} ${Date.now()}-${Math.random()}` },
  });
  titleIds.push(title.id);
  return title;
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  await prisma.professionalTitle.deleteMany({ where: { id: { in: titleIds } } });
  titleIds.length = 0;
});

describe("catálogo de títulos", () => {
  it("el selector de una clínica solo ofrece los habilitados y activos", async () => {
    const clinic = await crearClinica();
    const habilitado = await crearTitulo("Dra.");
    const inactivo = await crearTitulo("Lic.");
    await crearTitulo("Manicurista"); // existe en el catálogo, sin habilitar

    await setClinicTitles(clinic.id, [habilitado.id, inactivo.id]);
    await prisma.professionalTitle.update({
      where: { id: inactivo.id },
      data: { active: false },
    });

    const ofrecidos = await listTitlesForClinic(clinic.id);

    expect(ofrecidos.map((t) => t.id)).toEqual([habilitado.id]);
  });

  it("no habilita un título que no existe, y no toca lo que ya estaba", async () => {
    const clinic = await crearClinica();
    const title = await crearTitulo("Dra.");
    await setClinicTitles(clinic.id, [title.id]);

    const result = await setClinicTitles(clinic.id, [title.id, "id-inventado"]);

    expect(result).toEqual({ ok: false, reason: "titulo_inexistente" });
    expect(await listClinicTitleIds(clinic.id)).toEqual([title.id]);
  });

  describe("bajas bloqueadas", () => {
    /** Una clínica con el título habilitado y un profesional que lo usa. */
    async function conProfesionalUsandolo() {
      const clinic = await crearClinica();
      const title = await crearTitulo("Dra.");
      await setClinicTitles(clinic.id, [title.id]);
      await prisma.professional.create({
        data: { clinicId: clinic.id, name: "Gómez", titleId: title.id },
      });
      return { clinic, title };
    }

    it("no se puede desactivar un título que algún profesional tiene puesto", async () => {
      const { title } = await conProfesionalUsandolo();

      const result = await updateTitle(title.id, { active: false });

      expect(result).toEqual({ ok: false, reason: "en_uso", profesionales: 1 });
      const despues = await prisma.professionalTitle.findUnique({ where: { id: title.id } });
      expect(despues?.active).toBe(true);
    });

    it("no se puede quitarle a una clínica un título que sus profesionales usan", async () => {
      const { clinic, title } = await conProfesionalUsandolo();

      const result = await setClinicTitles(clinic.id, []);

      expect(result).toEqual({
        ok: false,
        reason: "en_uso",
        enUso: [{ name: title.name, profesionales: 1 }],
      });
      expect(await listClinicTitleIds(clinic.id)).toEqual([title.id]);
    });

    it("un profesional desactivado igual bloquea la baja: su ficha sigue mostrando el título", async () => {
      const { clinic, title } = await conProfesionalUsandolo();
      await prisma.professional.updateMany({ where: { clinicId: clinic.id }, data: { active: false } });

      expect(await updateTitle(title.id, { active: false })).toMatchObject({ reason: "en_uso" });
      expect(await setClinicTitles(clinic.id, [])).toMatchObject({ reason: "en_uso" });
    });

    it("el uso en OTRA clínica no bloquea quitárselo a esta", async () => {
      const { title } = await conProfesionalUsandolo();
      const otra = await crearClinica();
      await setClinicTitles(otra.id, [title.id]);

      // Nadie en `otra` lo usa, así que se lo puede quitar aunque la primera
      // clínica lo tenga puesto en un profesional.
      expect(await setClinicTitles(otra.id, [])).toEqual({ ok: true });
      expect(await listClinicTitleIds(otra.id)).toEqual([]);
    });

    it("renombrar sí está permitido con el título en uso", async () => {
      const { title } = await conProfesionalUsandolo();

      const result = await updateTitle(title.id, { name: `Doctora ${Date.now()}` });

      expect(result).toEqual({ ok: true });
    });

    it("desactivar un título que nadie usa está permitido", async () => {
      const clinic = await crearClinica();
      const title = await crearTitulo("Lic.");
      await setClinicTitles(clinic.id, [title.id]);

      expect(await updateTitle(title.id, { active: false })).toEqual({ ok: true });
    });
  });
});
