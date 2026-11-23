import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "../../lib/cn";
import { displayAIso, enmascararFecha, isoADisplay } from "../../lib/date-format";

/**
 * Campo de fecha que SIEMPRE se ve y se escribe como DD/MM/AAAA.
 *
 * Un `<input type="date">` nativo no sirve para esto: su formato lo decide el
 * idioma de interfaz del navegador, no la página. Con Chrome en inglés se ve
 * 09/15/2026 aunque el documento diga `lang="es"`, y no hay atributo ni CSS
 * que lo cambie — está verificado, no es una suposición. Para una plataforma
 * que opera en países que escriben DD/MM/AAAA, eso significa que la misma
 * pantalla dice cosas distintas según quién la abra, y "09/10/2026" es una
 * fecha válida leída de las dos formas: nadie se da cuenta de que está mal.
 *
 * Por eso el texto lo maneja este componente y el `<input type="date">` queda
 * solo como calendario: invisible, y se abre con `showPicker()` desde el
 * botón. Así se conserva el selector nativo sin heredar su formato.
 *
 * Hacia afuera el valor sigue siendo `YYYY-MM-DD` (lo que esperan la API y
 * `dateKeyToUtcMidnight`), así que es reemplazo directo de lo que había.
 */

export interface DateFieldProps {
  id?: string;
  /** Siempre `YYYY-MM-DD`, o "" si está vacío. */
  value: string;
  /** Recibe `YYYY-MM-DD`, o "" mientras la fecha esté incompleta. */
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function DateField({ id, value, onChange, disabled, className }: DateFieldProps) {
  const [texto, setTexto] = useState(() => isoADisplay(value));
  const picker = useRef<HTMLInputElement>(null);

  /*
   * El valor puede cambiar desde afuera (se carga la pantalla, se resetea un
   * filtro). Se sincroniza solo cuando representa una fecha distinta de la
   * que ya se está mostrando: comparar el texto pisaría lo que la persona
   * está tecleando a medias.
   */
  useEffect(() => {
    if (displayAIso(texto) !== value) setTexto(isoADisplay(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handleTexto(entrada: string) {
    const enmascarado = enmascararFecha(entrada);
    setTexto(enmascarado);
    // Mientras la fecha esté a medias, hacia afuera es "" — así nadie
    // interpreta "15/09/20" como el año 20.
    onChange(displayAIso(enmascarado) ?? "");
  }

  /*
   * Solo con la fecha completa: marcar en rojo mientras todavía se escribe
   * convierte cada tecla en un error, y no lo es.
   */
  const invalida = texto.length === 10 && displayAIso(texto) === null;

  return (
    <div className={cn("date-field", className)}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className="input date-field__text"
        placeholder="DD/MM/AAAA"
        maxLength={10}
        value={texto}
        disabled={disabled}
        aria-invalid={invalida || undefined}
        onChange={(e) => handleTexto(e.target.value)}
      />
      <button
        type="button"
        className="date-field__picker"
        disabled={disabled}
        aria-label="Abrir calendario"
        onClick={() => picker.current?.showPicker?.()}
      >
        <CalendarDays size={16} />
      </button>
      {/*
        * Solo el calendario. No se ve nunca, así que su formato —el que
        * depende del navegador— tampoco.
        */}
      <input
        ref={picker}
        type="date"
        className="date-field__native"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        onChange={(e) => {
          setTexto(isoADisplay(e.target.value));
          onChange(e.target.value);
        }}
      />
    </div>
  );
}
