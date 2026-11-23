/**
 * Banner de configuración incompleta.
 *
 * Consume `GET /dashboard/clinics/:id/config-health` y muestra qué le falta
 * configurar a la clínica, con la acción concreta cuando se puede resolver
 * de un click (cargar los feriados, elegir el país).
 *
 * Está pensado para embeberse: `renderConfigBanner(contenedor, clinicId)`.
 * Cuando exista el dashboard de verdad, se importa esta función tal cual en
 * vez de reimplementar el banner.
 *
 * Sin dependencias ni build step a propósito — el proyecto no tiene
 * bundler, y un banner no justifica agregarlo.
 *
 * Todo lo que viene del servidor se inserta con textContent y nunca con
 * innerHTML: el nombre de la clínica y los mensajes salen de la base, y no
 * hay razón para darles capacidad de inyectar markup.
 */

const ICONOS = {
  bloqueante: "⚠", // ⚠
  advertencia: "•", // •
  ok: "✓", // ✓
};

const ETIQUETAS = {
  bloqueante: "Acción requerida",
  advertencia: "Pendiente",
};

function el(tag, className, texto) {
  const nodo = document.createElement(tag);
  if (className) nodo.className = className;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

/** Arma la caja de un issue, con su severidad y sus controles si tiene. */
function crearIssue(issue, contexto) {
  const caja = el("div", `cb-issue cb-issue--${issue.severidad}`);

  // Un bloqueante significa que el asistente está tomando turnos que no
  // debería: se anuncia a los lectores de pantalla en cuanto aparece.
  if (issue.severidad === "bloqueante") {
    caja.setAttribute("role", "alert");
  }

  const icono = el("span", "cb-icono", ICONOS[issue.severidad] ?? ICONOS.advertencia);
  // Decorativo: la severidad ya se lee en la etiqueta de texto.
  icono.setAttribute("aria-hidden", "true");
  caja.appendChild(icono);

  const cuerpo = el("div", "cb-cuerpo");
  cuerpo.appendChild(el("span", "cb-etiqueta", ETIQUETAS[issue.severidad] ?? "Pendiente"));
  cuerpo.appendChild(el("p", "cb-mensaje", issue.mensaje));
  if (issue.accion) {
    cuerpo.appendChild(el("p", "cb-accion", issue.accion));
  }

  const controles = crearControles(issue, contexto);
  if (controles) cuerpo.appendChild(controles);

  caja.appendChild(cuerpo);
  return caja;
}

/**
 * Los controles de un issue, cuando se puede resolver desde acá.
 *
 * No todos tienen: cargar el horario de atención necesita un editor de
 * tramos por día, que es una pantalla aparte y no un botón. En ese caso el
 * banner solo explica qué falta.
 */
function crearControles(issue, contexto) {
  if (issue.code === "feriados_sin_cargar") {
    return controlesFeriados(issue, contexto);
  }
  if (issue.code === "sin_pais_configurado") {
    return controlesPais(issue, contexto);
  }
  if (issue.code === "no_autenticado") {
    return controlesLogin();
  }
  return null;
}

/** Link a la pantalla de login de la SPA, volviendo a esta misma URL después. */
function controlesLogin() {
  const controles = el("div", "cb-controles");
  const link = document.createElement("a");
  link.className = "cb-boton";
  link.href = `/app/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
  link.textContent = "Iniciar sesión";
  controles.appendChild(link);
  return controles;
}

/** Navega a la pantalla de login, volviendo a esta misma URL después. */
function irALogin() {
  location.href = `/app/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Los endpoints de /dashboard ahora exigen sesión — 401 significa eso, no un error de red. */
function issueNoAutenticado() {
  return {
    code: "no_autenticado",
    severidad: "bloqueante",
    mensaje: "Necesitás iniciar sesión para ver y editar esta configuración.",
    accion: "",
  };
}

function controlesFeriados(issue, contexto) {
  const porAnio = (issue.datos && issue.datos.pendientesPorAnio) || [];
  if (porAnio.length === 0) return null;

  const controles = el("div", "cb-controles");
  const estado = el("p", "cb-estado");
  estado.setAttribute("role", "status");

  // Un botón por año. Desde diciembre aparece también el año siguiente,
  // para que el calendario quede confirmado antes del 1 de enero.
  for (const { year, pendientes } of porAnio) {
    const boton = el(
      "button",
      "cb-boton",
      `Cargar ${pendientes} feriado(s) de ${year}`
    );
    boton.type = "button";

    boton.addEventListener("click", async () => {
      boton.disabled = true;
      estado.textContent = "Cargando…";
      try {
        const respuesta = await fetch(
          `/dashboard/clinics/${encodeURIComponent(contexto.clinicId)}/holidays/apply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ year }),
          }
        );
        if (respuesta.status === 401) return irALogin();
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

        const datos = await respuesta.json();
        estado.textContent = `Se cargaron ${datos.cargados.length} feriado(s) de ${year}.`;
        // Se vuelve a pedir el estado para que el banner refleje lo que
        // quedó, en vez de asumir que ya no falta nada.
        await contexto.refrescar();
      } catch (error) {
        boton.disabled = false;
        estado.textContent = `No se pudieron cargar: ${error.message}`;
      }
    });

    controles.appendChild(boton);
  }

  controles.appendChild(estado);
  return controles;
}

function controlesPais(issue, contexto) {
  const paises = (issue.datos && issue.datos.paisesSoportados) || [];
  if (paises.length === 0) return null;

  const controles = el("div", "cb-controles");

  const etiqueta = el("label", null, "País:");
  const select = el("select", "cb-select");
  const idSelect = `cb-pais-${Math.random().toString(36).slice(2)}`;
  select.id = idSelect;
  etiqueta.setAttribute("for", idSelect);

  const vacia = el("option", null, "Elegir…");
  vacia.value = "";
  select.appendChild(vacia);

  for (const pais of paises) {
    const opcion = el("option", null, pais.name);
    opcion.value = pais.id;
    // El país sugerido por la zona horaria de la clínica viene
    // preseleccionado, pero se puede cambiar.
    if (issue.datos && issue.datos.sugerido === pais.id) opcion.selected = true;
    select.appendChild(opcion);
  }

  const boton = el("button", "cb-boton", "Guardar");
  boton.type = "button";
  const estado = el("p", "cb-estado");
  estado.setAttribute("role", "status");

  boton.addEventListener("click", async () => {
    if (!select.value) {
      estado.textContent = "Elige un país primero.";
      return;
    }
    boton.disabled = true;
    estado.textContent = "Guardando…";
    try {
      const respuesta = await fetch(
        `/dashboard/clinics/${encodeURIComponent(contexto.clinicId)}/country`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ country: select.value }),
        }
      );
      if (respuesta.status === 401) return irALogin();
      if (!respuesta.ok) {
        const detalle = await respuesta.json().catch(() => ({}));
        throw new Error(detalle.error || `HTTP ${respuesta.status}`);
      }
      await contexto.refrescar();
    } catch (error) {
      boton.disabled = false;
      estado.textContent = `No se pudo guardar: ${error.message}`;
    }
  });

  controles.appendChild(etiqueta);
  controles.appendChild(select);
  controles.appendChild(boton);
  controles.appendChild(estado);
  return controles;
}

/**
 * Monta el banner en un contenedor.
 *
 * `opciones.mostrarSiEstaOk` decide qué pasa cuando no falta nada: por
 * default el banner desaparece, que es lo que se quiere embebido en un
 * dashboard. La página de configuración lo pone en true para confirmar que
 * está todo bien en vez de no mostrar nada.
 */
export async function renderConfigBanner(contenedor, clinicId, opciones = {}) {
  const contexto = {
    clinicId,
    refrescar: () => renderConfigBanner(contenedor, clinicId, opciones),
  };

  const pintar = (nodos) => {
    contenedor.textContent = "";
    const lista = el("div", "cb-lista");
    for (const nodo of nodos) lista.appendChild(nodo);
    contenedor.appendChild(lista);
  };

  contenedor.textContent = "";
  contenedor.appendChild(el("p", "cb-vacio", "Revisando la configuración…"));

  let health;
  try {
    const respuesta = await fetch(
      `/dashboard/clinics/${encodeURIComponent(clinicId)}/config-health`
    );
    if (respuesta.status === 401) {
      pintar([crearIssue(issueNoAutenticado(), contexto)]);
      return;
    }
    if (respuesta.status === 404) {
      pintar([
        crearIssue(
          {
            code: "no_encontrada",
            severidad: "bloqueante",
            mensaje: "No se encontró la clínica.",
            accion: "Revisar el identificador.",
          },
          contexto
        ),
      ]);
      return;
    }
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
    health = await respuesta.json();
  } catch (error) {
    // Que no se pueda leer el estado NO significa que la configuración esté
    // bien: se muestra el fallo en vez de un banner vacío.
    pintar([
      crearIssue(
        {
          code: "error_de_red",
          severidad: "advertencia",
          mensaje: `No se pudo verificar la configuración: ${error.message}`,
          accion: "Reintentar en un momento.",
        },
        contexto
      ),
    ]);
    return;
  }

  if (health.ok) {
    if (!opciones.mostrarSiEstaOk) {
      contenedor.textContent = "";
      return;
    }
    pintar([
      crearIssue(
        {
          code: "ok",
          severidad: "ok",
          mensaje: "La configuración está completa.",
          accion: "",
        },
        contexto
      ),
    ]);
    return;
  }

  // El servidor ya devuelve los bloqueantes primero; se reordena igual para
  // no depender de eso.
  const ordenados = [...health.issues].sort((a, b) => {
    if (a.severidad === b.severidad) return 0;
    return a.severidad === "bloqueante" ? -1 : 1;
  });

  pintar(ordenados.map((issue) => crearIssue(issue, contexto)));
}
