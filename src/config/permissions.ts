/**
 * Catálogo fijo de permisos del sistema. Es la única fuente de verdad:
 * `prisma/seed.ts` la usa para poblar la tabla `Permission`, y las rutas
 * usan las constantes de `PERMISSIONS` (nunca un string suelto) para no
 * desincronizarse con lo que hay seedeado en la base.
 *
 * Los admins arman roles combinando estos permisos desde la UI, pero no
 * pueden crear permisos nuevos: un permiso nuevo requiere una feature real
 * de código detrás, así que se agrega acá.
 */

export const PERMISSIONS = {
  USUARIOS_VER: "usuarios.ver",
  USUARIOS_CREAR: "usuarios.crear",
  USUARIOS_EDITAR: "usuarios.editar",
  USUARIOS_ELIMINAR: "usuarios.eliminar",
  ROLES_VER: "roles.ver",
  ROLES_GESTIONAR: "roles.gestionar",

  CLINICAS_VER: "clinicas.ver",
  CLINICAS_CREAR: "clinicas.crear",
  CLINICAS_EDITAR: "clinicas.editar",

  PAISES_VER: "paises.ver",
  PAISES_EDITAR: "paises.editar",

  PLANES_VER: "planes.ver",
  PLANES_EDITAR: "planes.editar",

  TITULOS_VER: "titulos.ver",
  TITULOS_EDITAR: "titulos.editar",

  SECRETOS_VER: "secretos.ver",
  SECRETOS_EDITAR: "secretos.editar",

  // Salud del sistema: worker, colas y errores. Solo el super-admin.
  MONITOREO_VER: "monitoreo.ver",

  // Consumo y costo de la plataforma (modelo de IA, WhatsApp, integraciones) y sus tarifas. Solo el super-admin.
  COSTOS_VER: "costos.ver",
  COSTOS_EDITAR: "costos.editar",

  TURNOS_VER: "turnos.ver",
  // Crear, mover, editar y cancelar citas, y cargar bloqueos, desde la Agenda.
  // Aparte de `turnos.ver` a propósito: ver citas lo hace cualquiera del equipo,
  // modificarlas es de quien lleva la agenda (recepción, asistentes).
  CITAS_GESTIONAR: "citas.gestionar",
  CONVERSACIONES_VER: "conversaciones.ver",

  CALENDARIOS_VER: "calendarios.ver",
  CALENDARIOS_EDITAR: "calendarios.editar",

  HORARIOS_VER: "horarios.ver",
  HORARIOS_EDITAR: "horarios.editar",

  FERIADOS_VER: "feriados.ver",
  FERIADOS_EDITAR: "feriados.editar",

  DERIVACIONES_VER: "derivaciones.ver",
  DERIVACIONES_GESTIONAR: "derivaciones.gestionar",

  SERVICIOS_VER: "servicios.ver",
  SERVICIOS_EDITAR: "servicios.editar",
  RECURSOS_VER: "recursos.ver",
  RECURSOS_EDITAR: "recursos.editar",

  // Alcanza un solo par para el catálogo de plataforma y para la lista de
  // cada clínica: las rutas de `/platform` ya exigen super-admin por el
  // router, así que un admin de clínica con `seguros.editar` solo puede
  // tocar la lista de su clínica.
  SEGUROS_VER: "seguros.ver",
  SEGUROS_EDITAR: "seguros.editar",

  // Paquetes de sesiones prepagas: verlos, venderlos/editarlos, y marcar las
  // citas como atendidas (lo que descuenta la sesión). Esto último va con
  // `paquetes.gestionar` y no con `citas.gestionar`: quien confirma una
  // asistencia está tocando el saldo prepago del paciente.
  // Pacientes: ver su ficha (datos, observaciones, comentarios, historial) y
  // editarla. Aparte de `turnos.ver`: la ficha tiene notas internas del personal.
  PACIENTES_VER: "pacientes.ver",
  PACIENTES_EDITAR: "pacientes.editar",

  // Reportes de citas (canceladas, reagendadas, atendidas…). Los detalles muestran
  // nombres de pacientes, y ver o exportar un reporte queda en la auditoría.
  REPORTES_VER: "reportes.ver",

  // Campañas y promociones: de dónde llegan los mensajes, qué se promociona y el seguimiento.
  CAMPANAS_VER: "campanas.ver",
  CAMPANAS_EDITAR: "campanas.editar",

  // El chat de pruebas con el asistente: cada mensaje llama al modelo (cuesta) y crea datos de prueba.
  CHAT_PRUEBAS_USAR: "chat_pruebas.usar",

  // La auditoría: ver quién hizo qué. De clínica (ve lo de la suya) y, para el
  // super-admin, de toda la plataforma. Solo lectura: el registro no se edita.
  AUDITORIA_VER: "auditoria.ver",

  PAQUETES_VER: "paquetes.ver",
  PAQUETES_GESTIONAR: "paquetes.gestionar",

  CONFIGURACION_VER: "configuracion.ver",
  CONFIGURACION_EDITAR: "configuracion.editar",

  METRICAS_VER: "metricas.ver",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Permisos que solo tienen sentido a nivel plataforma (no por clínica). */
export const PLATFORM_ONLY_PERMISSIONS: PermissionKey[] = [
  PERMISSIONS.CLINICAS_VER,
  PERMISSIONS.CLINICAS_CREAR,
  PERMISSIONS.CLINICAS_EDITAR,
  PERMISSIONS.PAISES_VER,
  PERMISSIONS.PAISES_EDITAR,
  PERMISSIONS.PLANES_VER,
  PERMISSIONS.PLANES_EDITAR,
  // El catálogo de títulos es de la plataforma, y quién los habilita en cada
  // clínica también: una clínica no elige con qué títulos trabaja.
  PERMISSIONS.TITULOS_VER,
  PERMISSIONS.TITULOS_EDITAR,
  // Cuándo vencen los secretos de las integraciones de la plataforma.
  PERMISSIONS.SECRETOS_VER,
  PERMISSIONS.SECRETOS_EDITAR,
  // El estado del worker, las colas y los errores de TODAS las clínicas.
  PERMISSIONS.MONITOREO_VER,
  // Cuánto cuesta cada clínica y la plataforma: no es algo que una clínica vea de sí misma ni de las demás.
  PERMISSIONS.COSTOS_VER,
  PERMISSIONS.COSTOS_EDITAR,
  // El registro de auditoría trae IPs y user agents: es técnico y es de la plataforma. Una
  // clínica no tiene pantalla de auditoría (la ve el super-admin, filtrando por clínica).
  PERMISSIONS.AUDITORIA_VER,
];

interface PermissionDefinition {
  id: PermissionKey;
  description: string;
  group: string;
}

/** Catálogo completo con descripción y agrupador, para el seed y la UI. */
export const PERMISSION_CATALOG: PermissionDefinition[] = [
  { id: PERMISSIONS.USUARIOS_VER, description: "Ver usuarios de la clínica", group: "Usuarios" },
  { id: PERMISSIONS.USUARIOS_CREAR, description: "Crear usuarios", group: "Usuarios" },
  { id: PERMISSIONS.USUARIOS_EDITAR, description: "Editar usuarios", group: "Usuarios" },
  { id: PERMISSIONS.USUARIOS_ELIMINAR, description: "Eliminar (desactivar) usuarios", group: "Usuarios" },
  { id: PERMISSIONS.ROLES_VER, description: "Ver roles y sus permisos", group: "Usuarios" },
  { id: PERMISSIONS.ROLES_GESTIONAR, description: "Crear, editar y asignar permisos a roles", group: "Usuarios" },

  { id: PERMISSIONS.CLINICAS_VER, description: "Ver clínicas de la plataforma", group: "Clínicas" },
  { id: PERMISSIONS.CLINICAS_CREAR, description: "Crear clínicas nuevas", group: "Clínicas" },
  { id: PERMISSIONS.CLINICAS_EDITAR, description: "Editar clínicas", group: "Clínicas" },

  { id: PERMISSIONS.PAISES_VER, description: "Ver países y su catálogo de feriados", group: "Países" },
  { id: PERMISSIONS.PAISES_EDITAR, description: "Agregar países y editar su catálogo de feriados", group: "Países" },

  { id: PERMISSIONS.PLANES_VER, description: "Ver planes y sus funcionalidades", group: "Planes" },
  { id: PERMISSIONS.PLANES_EDITAR, description: "Crear planes y editar qué funcionalidades incluyen", group: "Planes" },

  { id: PERMISSIONS.TITULOS_VER, description: "Ver el catálogo de títulos de profesional", group: "Títulos" },
  { id: PERMISSIONS.TITULOS_EDITAR, description: "Cargar títulos y habilitarlos por clínica", group: "Títulos" },

  { id: PERMISSIONS.SECRETOS_VER, description: "Ver cuándo vencen los secretos de las integraciones", group: "Secretos" },
  { id: PERMISSIONS.SECRETOS_EDITAR, description: "Registrar el vencimiento de un secreto", group: "Secretos" },

  { id: PERMISSIONS.MONITOREO_VER, description: "Ver la salud del sistema: tareas programadas, colas y errores", group: "Monitoreo" },

  { id: PERMISSIONS.COSTOS_VER, description: "Ver el consumo y el costo de cada clínica y de la plataforma", group: "Costos" },
  { id: PERMISSIONS.COSTOS_EDITAR, description: "Cargar las tarifas (modelo de IA, WhatsApp, integraciones) y los tipos de cambio", group: "Costos" },

  { id: PERMISSIONS.TURNOS_VER, description: "Buscar y ver citas", group: "Citas" },
  {
    id: PERMISSIONS.CITAS_GESTIONAR,
    description: "Crear, mover, editar y cancelar citas y cargar bloqueos desde la Agenda",
    group: "Citas",
  },
  { id: PERMISSIONS.CONVERSACIONES_VER, description: "Ver auditoría de conversaciones", group: "Citas" },

  { id: PERMISSIONS.CALENDARIOS_VER, description: "Ver configuración de calendarios", group: "Calendarios" },
  { id: PERMISSIONS.CALENDARIOS_EDITAR, description: "Conectar/editar calendarios", group: "Calendarios" },

  { id: PERMISSIONS.HORARIOS_VER, description: "Ver horarios de atención", group: "Horarios" },
  { id: PERMISSIONS.HORARIOS_EDITAR, description: "Editar horarios y excepciones", group: "Horarios" },

  { id: PERMISSIONS.FERIADOS_VER, description: "Ver feriados sugeridos", group: "Feriados" },
  { id: PERMISSIONS.FERIADOS_EDITAR, description: "Aplicar feriados", group: "Feriados" },

  { id: PERMISSIONS.DERIVACIONES_VER, description: "Ver los casos que esperan a una persona", group: "Por atender" },
  { id: PERMISSIONS.DERIVACIONES_GESTIONAR, description: "Marcar casos como atendidos", group: "Por atender" },

  { id: PERMISSIONS.SERVICIOS_VER, description: "Ver el catálogo de servicios", group: "Servicios" },
  { id: PERMISSIONS.SERVICIOS_EDITAR, description: "Cargar y editar servicios", group: "Servicios" },
  { id: PERMISSIONS.RECURSOS_VER, description: "Ver profesionales, espacios y equipos", group: "Recursos" },
  { id: PERMISSIONS.RECURSOS_EDITAR, description: "Cargar y editar profesionales, espacios y equipos", group: "Recursos" },

  { id: PERMISSIONS.SEGUROS_VER, description: "Ver con qué seguros trabaja la clínica", group: "Seguros" },
  { id: PERMISSIONS.SEGUROS_EDITAR, description: "Tomar seguros y darlos de baja", group: "Seguros" },

  { id: PERMISSIONS.PACIENTES_VER, description: "Ver la ficha de los pacientes: datos, observaciones, comentarios e historial", group: "Pacientes" },
  {
    id: PERMISSIONS.PACIENTES_EDITAR,
    description: "Crear pacientes, editar su ficha, agregar comentarios y fijar la próxima cita sugerida",
    group: "Pacientes",
  },

  { id: PERMISSIONS.CHAT_PRUEBAS_USAR, description: "Usar el chat de pruebas: hablar con el asistente desde el panel, sin pasar por WhatsApp", group: "Chat de pruebas" },
  { id: PERMISSIONS.CAMPANAS_VER, description: "Ver las campañas, quiénes llegaron por cada una y su seguimiento", group: "Campañas" },
  { id: PERMISSIONS.CAMPANAS_EDITAR, description: "Crear y editar campañas y promociones, y cerrar el seguimiento de un contacto", group: "Campañas" },
  { id: PERMISSIONS.REPORTES_VER, description: "Ver y exportar los reportes de citas: canceladas, reagendadas, atendidas por profesional", group: "Reportes" },
  { id: PERMISSIONS.AUDITORIA_VER, description: "Ver el registro de auditoría: quién hizo qué y cuándo", group: "Auditoría" },

  { id: PERMISSIONS.PAQUETES_VER, description: "Ver los paquetes de sesiones de los pacientes y cuántas les quedan", group: "Paquetes" },
  {
    id: PERMISSIONS.PAQUETES_GESTIONAR,
    description: "Cargar y editar paquetes, y marcar citas como atendidas (descuenta la sesión)",
    group: "Paquetes",
  },

  { id: PERMISSIONS.CONFIGURACION_VER, description: "Ver estado de configuración de la clínica", group: "Configuración" },
  { id: PERMISSIONS.CONFIGURACION_EDITAR, description: "Editar configuración (país, etc.)", group: "Configuración" },

  { id: PERMISSIONS.METRICAS_VER, description: "En desuso: la pantalla de Métricas ahora es el Resumen de Reportes (permiso reportes.ver)", group: "Métricas" },
];

/** Todos los permisos, para el rol "Super Admin". */
export const ALL_PERMISSION_IDS: PermissionKey[] = PERMISSION_CATALOG.map((p) => p.id);

/** Todos menos los de plataforma, para el rol "Admin de clínica". */
export const CLINIC_ADMIN_PERMISSION_IDS: PermissionKey[] = ALL_PERMISSION_IDS.filter(
  (id) => !PLATFORM_ONLY_PERMISSIONS.includes(id),
);
